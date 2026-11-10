/**
 * Stage 2 of the two-stage answer: evidence sufficiency. Stage 1 (`search` with no relevance floor) retrieves
 * high-recall candidates; this step decides, from those candidates only, whether they support an answer or the
 * answer is "not found in your documents". Deterministic and explainable: lexical signals only, no model calls.
 *
 * Decision (fixed before calibration):
 *  1. Only evidence counts. A candidate is considered only if it is binding, unflagged, of this workspace (S5
 *     `isEvidence`) AND S6's `sanitizePassage` accepts it as binding evidence (no injection, not self-declared
 *     non-binding). Anything else is listed in `excluded` and can never make the evidence sufficient.
 *  2. Anchors: every number (as a whole number: "2,500" is not matched by "2,400" and "500") and every proper name
 *     of the question (a capitalised word that does not start a sentence) must occur in the candidate's document: the
 *     passage, its title, or another evidence passage of the same document.
 *  3. Coverage: the question's content words (stop words, question words and anchors removed) that occur in the
 *     candidate's document title only point at the document; they are set aside. Coverage is the IDF-weighted share of
 *     the remaining topic words found in the candidate passage itself. IDF is over the workspace's evidence passages,
 *     so a word the workspace never uses weighs most.
 *  4. Sufficient iff some candidate among the first `topK` satisfies 2 and has coverage >= `minCoverage`.
 * Score margin and cross-passage agreement are reported as signals but do not decide. When sufficient, the answer
 * cites the considered candidates (judged, not excluded, within `topK`), never an excluded or unjudged one.
 * Known limits: a name in first position is not an anchor; generic question words ("say", "about") count as topic;
 * an abbreviation ("IP", "MSA") is an anchor and must occur literally; "3rd" is not matched by "third".
 */
import { sanitizePassage } from "../security/sanitize";
import { isEvidence, QUESTION_WORDS, searchDetailed, type Candidate, type SearchRequest, type SearchResult } from "./retrieve";
import { tokenize } from "./text";
import type { Index, IndexedPassage } from "./types";

/**
 * Coverage threshold selected on the development split (integration/m3/dev/abstention-dev.ts) by the rule in
 * test/integration-m3/evidence-calibration.test.ts. Not tuned on S15 (seen) or on the held-out split.
 */
export const DEFAULT_MIN_COVERAGE = 0.3;
export const DEFAULT_EVIDENCE_TOP_K = 5;

export type EvidenceCandidate = { passage: IndexedPassage; score: number };

export type EvidenceOptions = {
  workspaceId: string;
  /** The document's title (the app's own metadata, not indexed text). Missing titles simply match nothing. */
  title?: (documentId: string) => string | undefined;
  /** Every evidence passage of the workspace the caller may read: IDF and document-level anchor lookup. */
  evidence: IndexedPassage[];
  minCoverage?: number;
  topK?: number;
};

export type CandidateSignals = {
  /** Position of this candidate in the list given to assessEvidence. */
  candidateIndex: number;
  documentId: string;
  passageId: string;
  rank: number;
  coverage: number;
  /** Content words found only in the document title (they identify the document). */
  titleTerms: string[];
  /** Topic words (what is asked) and which of them the passage contains. */
  topicTerms: string[];
  coveredTerms: string[];
  missingAnchors: string[];
};

export type EvidenceReason = "sufficient" | "no-question-terms" | "no-evidence" | "missing-anchor" | "low-coverage";

export type EvidenceDecision = {
  sufficient: boolean;
  reason: EvidenceReason;
  /** The candidate that made the evidence sufficient (or came closest). */
  best?: CandidateSignals;
  anchors: string[];
  /** (score1 - score2) / score1 of the first two considered candidates; 1 with one candidate, 0 with none. */
  margin: number;
  /** Considered candidates whose document is the best one's and whose coverage also reaches the threshold. */
  agreement: number;
  considered: CandidateSignals[];
  excluded: { passageId: string; documentId: string; reason: "not-evidence" | "injection" | "non-binding" }[];
};

/** Whole numbers of a text, thousands separators removed: "1,240,000" -> "1240000", "9.40" -> "9.40". */
const NUMBER = /\p{N}+(?:[.,]\p{N}+)*/gu;
export function numbersOf(text: string): string[] {
  return [...String(text ?? "").matchAll(NUMBER)].map((m) => m[0].replace(/,(?=\p{N}{3}(?!\p{N}))/gu, ""));
}

// Capitalised but not names: the pronoun "I" (and its contractions) and honorifics, whose period ends no sentence.
const NOT_NAMES = new Set(["i", "i'm", "i've", "i'd", "i'll", "i’m", "i’ve", "i’d", "i’ll", "mr", "mrs", "ms", "dr", "prof"]);

/** Proper names of the question, as tokens (stemmed like passage text): capitalised words not starting a sentence. */
function nameAnchors(query: string): string[] {
  const out = new Set<string>();
  for (const m of String(query ?? "").matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
    if (NOT_NAMES.has(m[0].toLowerCase())) continue;
    const before = String(query).slice(0, m.index).trimEnd();
    const prev = before.match(/([\p{L}]+)[.!?:;]$/u)?.[1]?.toLowerCase();
    const sentenceStart = before === "" || (/[.!?:;]$/.test(before) && !(prev !== undefined && NOT_NAMES.has(prev)));
    if (sentenceStart || !/^\p{Lu}/u.test(m[0])) continue;
    for (const t of tokenize(m[0])) if (!QUESTION_WORDS.has(t) && !/^\p{N}+$/u.test(t)) out.add(t);
  }
  return [...out];
}

/** Numbers and proper names of the question (see `numbersOf` and the module comment). */
export function questionAnchors(query: string): string[] {
  return [...new Set([...nameAnchors(query), ...numbersOf(query)])];
}

function contentTerms(query: string): string[] {
  return [...new Set(tokenize(String(query ?? "").slice(0, 500)))].filter((t) => !QUESTION_WORDS.has(t)).slice(0, 32);
}

export function assessEvidence(query: string, candidates: EvidenceCandidate[], opts: EvidenceOptions): EvidenceDecision {
  const minCoverage = typeof opts.minCoverage === "number" && Number.isFinite(opts.minCoverage) ? Math.max(0, Math.min(1, opts.minCoverage)) : DEFAULT_MIN_COVERAGE;
  const topK = Number.isFinite(opts.topK) ? Math.max(1, Math.floor(opts.topK as number)) : DEFAULT_EVIDENCE_TOP_K;
  const names = nameAnchors(query);
  const numbers = [...new Set(numbersOf(query))];
  const anchors = [...new Set([...names, ...numbers])];
  const anchorSet = new Set(names);
  // numbers are matched as whole numbers, so their digit tokens ("1", "240", "000" of "1,240,000") are not topic words
  const numberTokens = new Set([...String(query ?? "").matchAll(NUMBER)].flatMap((m) => tokenize(m[0])));
  const terms = contentTerms(query).filter((t) => !numberTokens.has(t));
  const excluded: EvidenceDecision["excluded"] = [];
  const empty = (reason: EvidenceReason): EvidenceDecision => ({ sufficient: false, reason, anchors, margin: 0, agreement: 0, considered: [], excluded });

  // 1. only binding, unflagged, S6-accepted evidence of this workspace is ever considered
  const usable: (EvidenceCandidate & { at: number })[] = [];
  for (const [at, c] of candidates.slice(0, topK).entries()) {
    const p = c?.passage;
    if (!p || !isEvidence(p, opts.workspaceId)) {
      excluded.push({ passageId: typeof p?.id === "string" ? p.id : "", documentId: typeof p?.documentId === "string" ? p.documentId : "", reason: "not-evidence" });
      continue;
    }
    const s = sanitizePassage(p);
    if (!s.evidence) excluded.push({ passageId: p.id, documentId: p.documentId, reason: "injection" });
    else if (!s.binding) excluded.push({ passageId: p.id, documentId: p.documentId, reason: "non-binding" });
    else usable.push({ passage: { ...p, text: s.text }, score: c.score, at });
  }
  if (terms.length === 0 && anchors.length === 0) return empty("no-question-terms");
  if (usable.length === 0) return empty("no-evidence");

  // workspace statistics over the evidence passages (the same population stage 1 ranks)
  // the same rule as candidates: a passage S6 would not accept as binding evidence cannot satisfy an anchor either
  const ev = (opts.evidence ?? []).filter((p) => {
    if (!isEvidence(p, opts.workspaceId)) return false;
    const s = sanitizePassage(p);
    return s.evidence && s.binding;
  });
  const evToks = ev.map((p) => new Set(tokenize(p.text)));
  const N = ev.length;
  const idf = (t: string) => {
    const df = evToks.filter((s) => s.has(t)).length;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };
  const docToks = new Map<string, Set<string>>();
  const docNums = new Map<string, Set<string>>();
  ev.forEach((p, i) => {
    const d = docToks.get(p.documentId) ?? new Set<string>();
    for (const t of evToks[i]) d.add(t);
    docToks.set(p.documentId, d);
    const n = docNums.get(p.documentId) ?? new Set<string>();
    for (const x of numbersOf(p.text)) n.add(x);
    docNums.set(p.documentId, n);
  });

  const considered = usable.map((c, rank): CandidateSignals => {
    const p = c.passage;
    const own = new Set(tokenize(p.text));
    const titleText = String(opts.title?.(p.documentId) ?? "");
    const title = new Set(tokenize(titleText));
    const docAll = new Set([...(docToks.get(p.documentId) ?? []), ...own, ...title]);
    const docNumbers = new Set([...(docNums.get(p.documentId) ?? []), ...numbersOf(p.text), ...numbersOf(titleText)]);
    const missingAnchors = [...names.filter((a) => !docAll.has(a)), ...numbers.filter((n) => !docNumbers.has(n))];
    const nonAnchor = terms.filter((t) => !anchorSet.has(t));
    const titleTerms = nonAnchor.filter((t) => title.has(t) && !own.has(t));
    const topicTerms = nonAnchor.filter((t) => !titleTerms.includes(t));
    const coveredTerms = topicTerms.filter((t) => own.has(t));
    const total = topicTerms.reduce((a, t) => a + idf(t), 0);
    const coverage = total > 0 ? coveredTerms.reduce((a, t) => a + idf(t), 0) / total : 0;
    return { candidateIndex: c.at, documentId: p.documentId, passageId: p.id, rank: rank + 1, coverage, titleTerms, topicTerms, coveredTerms, missingAnchors };
  });

  const s1 = usable[0].score;
  const s2 = usable[1]?.score;
  const margin = s2 === undefined ? 1 : s1 > 0 ? (s1 - s2) / s1 : 0;
  const anchored = considered.filter((c) => c.missingAnchors.length === 0);
  const pick = (xs: CandidateSignals[]) => xs.reduce((a, b) => (b.coverage > a.coverage + 1e-12 ? b : a));
  if (anchored.length === 0)
    return { sufficient: false, reason: "missing-anchor", best: pick(considered), anchors, margin, agreement: 0, considered, excluded };
  const best = pick(anchored);
  const sufficient = best.coverage >= minCoverage - 1e-12;
  const agreement = anchored.filter((c) => c.documentId === best.documentId && c.coverage >= minCoverage - 1e-12).length;
  return { sufficient, reason: sufficient ? "sufficient" : "low-coverage", best, anchors, margin, agreement, considered, excluded };
}

export type EvidenceRequest = Omit<SearchRequest, "minRelevance"> & Pick<EvidenceOptions, "title" | "minCoverage" | "topK">;
/** Stage 1's result when the evidence is sufficient, otherwise no hits and `abstained`; always with the decision. */
export type EvidenceResult = SearchResult & { decision: EvidenceDecision; stage1: SearchResult };

const strip = (r: SearchResult): SearchResult => ({ hits: r.hits, truncated: r.truncated, contextChars: r.contextChars, skippedDocuments: r.skippedDocuments, abstained: r.abstained, relevance: r.relevance });

/** Stage 2 over already-retrieved (and, in the pipeline, verified) candidates, and the answer it allows. */
export function decide(query: string, stage1: SearchResult, candidates: Candidate[], evidence: IndexedPassage[], opts: Omit<EvidenceOptions, "evidence">): EvidenceResult {
  // a hit that does not quote its own passage is never judged or cited
  const paired = candidates.filter(
    (c) =>
      c?.hit?.citation?.passageId === c?.passage?.id &&
      c.hit.citation.documentId === c.passage.documentId &&
      c.hit.citation.versionId === c.passage.versionId &&
      typeof c.hit.citation.quote === "string" &&
      c.hit.citation.quote.trim() !== "" &&
      typeof c.passage.text === "string" &&
      c.passage.text.includes(c.hit.citation.quote),
  );
  const decision = assessEvidence(query, paired.map((c) => ({ passage: c.passage, score: c.hit.score })), { ...opts, evidence });
  const base = strip(stage1);
  if (!decision.sufficient)
    return { ...base, hits: [], contextChars: 0, truncated: false, abstained: true, decision, stage1 };
  // cite only what stage 2 judged and accepted: never an excluded candidate, nor one past topK
  const judged = new Set(decision.considered.map((c) => c.candidateIndex));
  const hits = paired.filter((_, i) => judged.has(i)).map((c) => c.hit);
  const contextChars = hits.reduce((a, h) => a + h.citation.quote.length, 0);
  return { ...base, hits, contextChars, truncated: base.truncated || hits.length < candidates.length, abstained: hits.length === 0, decision, stage1 };
}

/**
 * The two-stage answer: stage 1 is `search` with NO relevance floor (high recall; its hits are exactly the no-floor
 * hits), stage 2 is `assessEvidence` on those hits. Returns stage 1's hits unchanged when the evidence is sufficient,
 * and nothing (abstained) otherwise.
 */
export function searchWithEvidence(index: Index, req: EvidenceRequest): EvidenceResult {
  const d = searchDetailed(index, { ...req, minRelevance: 0 });
  return decide(req.query, strip(d), d.candidates, d.evidence, { workspaceId: req.workspaceId, title: req.title, minCoverage: req.minCoverage, topK: req.topK });
}
