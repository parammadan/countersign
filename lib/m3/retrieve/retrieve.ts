import type { Citation, Index, IndexedPassage } from "./types";
import { tokenize } from "./text";
import { sanitizePassage } from "../security/sanitize";

export type Limits = {
  /** Max hits returned (default 8, hard cap 50). */
  maxResults?: number;
  /** Max total characters of quotes in one response (default 4000, min 100, hard cap 20000). */
  maxContextChars?: number;
  /** Max hits per document (default 2). */
  maxPerDocument?: number;
  /** Max characters of one quote (default 600). */
  maxQuoteChars?: number;
  /**
   * Relevance floor in [0, 1] (default DEFAULT_MIN_RELEVANCE; 0 disables): below it `search` returns no hits and
   * reports `abstained`. Relevance is the best passage's IDF-weighted query-term coverage, see `relevanceOf`.
   */
  minRelevance?: number;
};

export type SearchRequest = Limits & { workspaceId: string; query: string };
export type Hit = { citation: Citation; score: number };
export type SearchResult = {
  hits: Hit[];
  truncated: boolean;
  contextChars: number;
  /** Documents excluded because the index returned several versions of them. */
  skippedDocuments: string[];
  /** True when the evidence was below the relevance floor (or there was none): the answer is "not found". */
  abstained: boolean;
  /** Relevance of the best passage, in [0, 1]. */
  relevance: number;
};

export type CompareRow = {
  documentId: string;
  versionId: string;
  citations: Citation[];
  /** True only when the document was fully examined and has no binding evidence on the topic. */
  missing: boolean;
  /** True when matching evidence exists but the context limit left no room to include it. */
  omitted: boolean;
};
export type CompareResult = { topic: string; rows: CompareRow[]; truncated: boolean; /** Documents excluded (ambiguous versions): NOT the same as `missing`. */ skippedDocuments: string[] };

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_CHARS = 500;
const MAX_QUERY_TERMS = 32;
/** Floor for maxContextChars: a smaller budget cannot hold a meaningful quote. */
const MIN_CONTEXT = 100;

function clamp(v: number | undefined, def: number, max: number, min = 1): number {
  const n = Number.isFinite(v) ? Math.floor(v as number) : def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Only binding, unflagged passages of exactly this workspace may be evidence. Fails closed: a passage without
 * `binding === true` and an explicit empty `flags` array is never evidence, whatever the index returned.
 */
export function isEvidence(p: IndexedPassage, workspaceId: string): boolean {
  return p.workspaceId === workspaceId && p.binding === true && Array.isArray(p.flags) && p.flags.length === 0 && typeof p.text === "string" && p.text.trim() !== "";
}

/**
 * Evidence passages plus the documents skipped because the index returned several versions of them. The version
 * check runs over ALL passages of the workspace, before the evidence filter, so a flagged or non-binding current
 * version cannot hide behind an older unflagged one. Ambiguous documents are skipped (fail closed).
 */
export function evidenceWithSkips(index: Index, workspaceId: string): { passages: IndexedPassage[]; skipped: string[] } {
  const all = index.passagesFor(workspaceId).filter((p) => p.workspaceId === workspaceId);
  const versions = new Map<string, Set<string | undefined>>();
  for (const p of all) {
    if (!versions.has(p.documentId)) versions.set(p.documentId, new Set());
    versions.get(p.documentId)!.add(typeof p.versionId === "string" && p.versionId ? p.versionId : undefined);
  }
  const ambiguous = (id: string) => {
    const v = versions.get(id)!;
    return v.size !== 1 || v.has(undefined);
  };
  const skipped = [...versions.keys()].filter(ambiguous).sort();
  // compat: serve the text S6 sanitised (hidden characters removed, fences neutralised) so that every quote is a
  // substring of what S6's verifier checks; drop what S6 would not accept as binding evidence.
  const passages: IndexedPassage[] = [];
  for (const p of all) {
    if (ambiguous(p.documentId) || !isEvidence(p, workspaceId)) continue;
    const san = sanitizePassage(p);
    if (!san.evidence || !san.binding || san.text.trim() === "") continue;
    passages.push({ ...p, text: san.text });
  }
  return { passages, skipped };
}

export function evidencePassages(index: Index, workspaceId: string): IndexedPassage[] {
  return evidenceWithSkips(index, workspaceId).passages;
}

function queryTerms(query: string): string[] {
  return [...new Set(tokenize(String(query ?? "").slice(0, MAX_QUERY_CHARS)))].slice(0, MAX_QUERY_TERMS);
}

/**
 * Relevance floor chosen on the development split in integration/m3/dev/abstention-dev.ts (balanced accuracy of
 * answering vs abstaining, ties to the lower floor; see test/integration-m3/abstention-dev.test.ts). Not tuned on S15.
 * Superseded for answering by the two-stage path (evidence.ts `searchWithEvidence`, pipeline `secureAnswer`), which
 * retrieves with no floor and decides answer vs abstain in a separate evidence step; kept as `search`'s default
 * until the owner retires it.
 */
export const DEFAULT_MIN_RELEVANCE = 0.55;

// Question function words (interrogatives, modals, "there"): they carry no topic, so they do not count against
// coverage. Ranking still sees them.
export const QUESTION_WORDS: ReadonlySet<string> = new Set(tokenize("when where why whom whose many much long often soon can could must should may might would shall there get", { keepStop: true }));

/**
 * Evidence-based relevance of one passage for a query, in [0, 1]: the IDF-weighted share of the query's topic terms
 * found in the passage or elsewhere in the same document (party names and defined terms often sit in another passage).
 * IDF is over the workspace's evidence passages; a term found nowhere in the workspace has the highest IDF, so a
 * question about something the documents never mention scores low however many of its other words match.
 */
function relevanceOf(i: number, terms: string[], idf: Map<string, number>, toks: Set<string>[], docToks: Set<string>, total: number): number {
  if (total <= 0) return 0;
  let got = 0;
  for (const t of terms) if (toks[i].has(t) || docToks.has(t)) got += idf.get(t) ?? 0;
  return got / total;
}

function scoreAll(passages: IndexedPassage[], terms: string[]): { p: IndexedPassage; score: number; relevance: number }[] {
  const toks = passages.map((p) => tokenize(p.text));
  const sets = toks.map((t) => new Set(t));
  const N = passages.length;
  const avg = toks.reduce((s, t) => s + t.length, 0) / (N || 1) || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, sets.filter((ts) => ts.has(t)).length);
  const idf = new Map(terms.map((t) => [t, Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))] as const));
  const topic = terms.filter((t) => !QUESTION_WORDS.has(t));
  const relTerms = topic.length ? topic : terms;
  const relTotal = relTerms.reduce((a, t) => a + (idf.get(t) ?? 0), 0);
  const docToks = new Map<string, Set<string>>();
  passages.forEach((p, i) => {
    const d = docToks.get(p.documentId) ?? new Set<string>();
    for (const t of sets[i]) d.add(t);
    docToks.set(p.documentId, d);
  });
  const out: { p: IndexedPassage; score: number; relevance: number }[] = [];
  passages.forEach((p, i) => {
    const tf = new Map<string, number>();
    for (const t of toks[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      score += ((idf.get(t) ?? 0) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks[i].length) / avg));
    }
    if (score > 0) out.push({ p, score, relevance: relevanceOf(i, relTerms, idf, sets, docToks.get(p.documentId)!, relTotal) });
  });
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      a.p.documentId.localeCompare(b.p.documentId) ||
      a.p.id.localeCompare(b.p.id),
  );
}

const ABBREV = new Set(["sec", "no", "art", "inc", "ltd", "co", "corp", "cl", "para", "e.g", "i.e", "etc", "vs", "approx", "st", "mr", "ms", "dr"]);

/** Sentence spans; a period inside "14.5", "Sec. 4" or "e.g." does not end a sentence. */
export function sentenceSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let start = 0;
  const re = /[.!?]+(?=\s|$)|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (m[0] !== "\n") {
      const word = (text.slice(Math.max(start, m.index - 24), m.index).match(/([\p{L}.]+)$/u)?.[1] ?? "").toLowerCase();
      const next = text.slice(end).match(/^\s*(\S)/)?.[1] ?? "";
      if (ABBREV.has(word) || (next !== "" && !/[\p{Lu}\p{N}"“(]/u.test(next))) continue;
    }
    if (text.slice(start, end).trim()) spans.push([start, end]);
    start = end;
  }
  if (text.slice(start).trim()) spans.push([start, text.length]);
  return spans.length ? spans : [[0, text.length]];
}

/** Verbatim excerpt: the sentence span of the passage matching the most query terms, always a substring of p.text. */
export function quoteFor(p: IndexedPassage, terms: string[], maxChars: number): string {
  const text = p.text;
  const spans = sentenceSpans(text);
  let best: [number, number] = [0, text.length];
  let bestN = -1;
  for (const [s, e] of spans) {
    const set = new Set(tokenize(text.slice(s, e)));
    const n = terms.filter((t) => set.has(t)).length;
    if (n > bestN) {
      bestN = n;
      best = [s, e];
    }
  }
  let q = text.slice(best[0], best[1]).trim();
  if (q.length > maxChars) {
    // window around the first query term so the quote still shows the evidence
    let at = -1;
    const re2 = /[\p{L}\p{N}]+/gu;
    for (let m = re2.exec(q); m && at < 0; m = re2.exec(q)) if (terms.includes(tokenize(m[0])[0])) at = m.index;
    const start = Math.max(0, Math.min(Math.max(0, at) - Math.floor(maxChars / 4), q.length - maxChars));
    let a = start;
    let b = Math.min(q.length, start + maxChars);
    // avoid cutting inside a word or number ("30 days" must not become "3")
    // (best effort: a single token longer than the window is returned as a clipped slice, still verbatim)
    if (b < q.length && /\S/.test(q[b])) {
      let e = b;
      while (e > a && /\S/.test(q[e - 1])) e--;
      if (e > a) b = e;
    }
    if (a > 0 && /\S/.test(q[a - 1])) {
      let s = a;
      while (s < b && /\S/.test(q[s])) s++;
      if (s < b) a = s;
    }
    q = q.slice(a, b);
    q = q.trim();
  }
  return q;
}

function cite(p: IndexedPassage, quote: string): Citation {
  return { documentId: p.documentId, versionId: p.versionId, passageId: p.id, page: p.page, quote };
}

/** One hit with the (sanitised) evidence passage it quotes: what stage 2 (evidence.ts) judges. */
export type Candidate = { hit: Hit; passage: IndexedPassage };
/** `search` plus what produced it: the candidate passages behind the hits and every evidence passage of the workspace. */
export type DetailedSearchResult = SearchResult & { candidates: Candidate[]; evidence: IndexedPassage[] };

export function search(index: Index, req: SearchRequest): SearchResult {
  const r = searchDetailed(index, req);
  return { hits: r.hits, truncated: r.truncated, contextChars: r.contextChars, skippedDocuments: r.skippedDocuments, abstained: r.abstained, relevance: r.relevance };
}

/** `search`, also returning the passages behind the hits (stage 1 of the two-stage answer, see evidence.ts). */
export function searchDetailed(index: Index, req: SearchRequest): DetailedSearchResult {
  const maxResults = clamp(req.maxResults, 8, 50);
  const maxCtx = clamp(req.maxContextChars, 4000, 20000, MIN_CONTEXT);
  const perDoc = clamp(req.maxPerDocument, 2, 50);
  const maxQuote = clamp(req.maxQuoteChars, 600, 5000);
  const minRel = typeof req.minRelevance === "number" && !Number.isNaN(req.minRelevance) ? Math.max(0, Math.min(1, req.minRelevance)) : DEFAULT_MIN_RELEVANCE;
  const terms = queryTerms(req.query);
  if (!req.workspaceId || terms.length === 0)
    return { hits: [], truncated: false, contextChars: 0, skippedDocuments: [], abstained: true, relevance: 0, candidates: [], evidence: [] };

  const ev = evidenceWithSkips(index, req.workspaceId);
  const ranked = scoreAll(ev.passages, terms);
  const relevance = ranked.reduce((m, r) => Math.max(m, r.relevance), 0);
  // Abstain: the best evidence covers too little of what was asked. Nothing is returned, not even weak hits.
  if (ranked.length === 0 || relevance < minRel)
    return { hits: [], truncated: false, contextChars: 0, skippedDocuments: ev.skipped, abstained: true, relevance, candidates: [], evidence: ev.passages };
  const hits: Hit[] = [];
  const candidates: Candidate[] = [];
  const perDocCount = new Map<string, number>();
  let used = 0;
  let truncated = false;
  for (const { p, score } of ranked) {
    if ((perDocCount.get(p.documentId) ?? 0) >= perDoc) {
      truncated = true;
      continue;
    }
    if (hits.length >= maxResults || maxCtx - used < 1) {
      truncated = true;
      break;
    }
    let quote = quoteFor(p, terms, maxQuote);
    if (quote.length > maxCtx - used) {
      // only the first hit may be shrunk to the budget; later ones that do not fit end the result
      if (used > 0) {
        truncated = true;
        break;
      }
      quote = quoteFor(p, terms, maxCtx);
    }
    used += quote.length;
    perDocCount.set(p.documentId, (perDocCount.get(p.documentId) ?? 0) + 1);
    const hit = { citation: cite(p, quote), score };
    hits.push(hit);
    candidates.push({ hit, passage: p });
  }
  return { hits, truncated, contextChars: used, skippedDocuments: ev.skipped, abstained: hits.length === 0, relevance, candidates, evidence: ev.passages };
}

const COMPARE_RE = /\b(compare|comparison|versus|vs|differ|differs|difference|differences)\b|\b(across|between)\s+(?:(?:all|my|our|the|these|each|of)\s+)*(agreements|contracts|documents|engagements|clients|files)\b/i;
const COMPARE_NOISE = new Set(["compare", "comparison", "versus", "vs", "differ", "difference", "across", "between", "agreement", "contract", "document", "show", "list", "me", "engagement", "client", "file"]);

export function isComparisonQuery(query: string): boolean {
  return COMPARE_RE.test(query);
}

/** Aligned per-document evidence for one topic: one row per workspace document, best passages first. */
export function compare(index: Index, req: SearchRequest): CompareResult {
  const maxPerDoc = clamp(req.maxPerDocument, 1, 10);
  const maxQuote = clamp(req.maxQuoteChars, 600, 5000);
  const maxCtx = clamp(req.maxContextChars, 4000, 20000, MIN_CONTEXT);
  const maxDocs = clamp(req.maxResults, 20, 50);
  const noise = new Set(tokenize([...COMPARE_NOISE].join(" ")));
  const terms = queryTerms(req.query).filter((t) => !noise.has(t));
  const topic = terms.join(" ");
  if (!req.workspaceId || terms.length === 0) return { topic, rows: [], truncated: false, skippedDocuments: [] };

  const evs = evidenceWithSkips(index, req.workspaceId);
  const all = evs.passages;
  const docs = new Map<string, string>();
  for (const p of all) docs.set(p.documentId, p.versionId);
  const ranked = scoreAll(all, terms);
  // When over the document cap keep the most relevant documents, then list rows in id order.
  const best = new Map<string, number>();
  for (const { p, score } of ranked) if (!best.has(p.documentId)) best.set(p.documentId, score);
  const chosen = [...docs]
    .sort(([a], [b]) => (best.get(b) ?? 0) - (best.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, maxDocs)
    .sort(([a], [b]) => a.localeCompare(b));

  const rows: CompareRow[] = [];
  let used = 0;
  let truncated = docs.size > maxDocs;
  for (const [documentId, versionId] of chosen) {
    const citations: Citation[] = [];
    let omitted = false;
    for (const { p } of ranked) {
      if (p.documentId !== documentId || citations.length >= maxPerDoc) continue;
      let quote = quoteFor(p, terms, maxQuote);
      if (quote.length > maxCtx - used) {
        if (used > 0) {
          truncated = true;
          omitted = true;
          break;
        }
        quote = quoteFor(p, terms, maxCtx);
      }
      used += quote.length;
      citations.push(cite(p, quote));
    }
    rows.push({ documentId, versionId, citations, missing: citations.length === 0 && !omitted, omitted: citations.length === 0 && omitted });
  }
  return { topic, rows, truncated, skippedDocuments: evs.skipped };
}

/** Routes a natural-language question: comparison phrasing gets aligned rows, anything else gets ranked hits. */
export function answer(index: Index, req: SearchRequest): { kind: "compare"; result: CompareResult } | { kind: "search"; result: SearchResult } {
  return isComparisonQuery(req.query)
    ? { kind: "compare", result: compare(index, req) }
    : { kind: "search", result: search(index, req) };
}
