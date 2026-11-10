// Metrics. Each per-case function is pure; `aggregate` combines results. Ratios with an empty
// denominator are null (not 0 and not 1), so "nothing to measure" is never mistaken for a score.
import { containsClaim, containsFact, extractClaims, normalize } from "./text.mjs";

const ratio = (num, den) => (den === 0 ? null : num / den);

/** Quotes shorter than this (normalised characters) are not accepted as evidence. */
export const MIN_QUOTE_CHARS = 10;

/** Does `quote` appear verbatim (after normalisation) on page `page` (1-based) of the given document? */
export function quoteOnPage(documents, citation) {
  const doc = documents.find((d) => d.id === citation?.docId);
  if (!doc || !Number.isInteger(citation.page) || citation.page < 1 || citation.page > doc.pages.length) return false;
  const quote = normalize(citation.quote ?? "");
  if (quote.length < MIN_QUOTE_CHARS) return false;
  return normalize(doc.pages[citation.page - 1]).includes(quote);
}

/** Citation accuracy inputs: how many citations are verbatim on the cited page. */
export function citationScore(c, out) {
  // Duplicate citations (same doc, page and quote) count once.
  const seen = new Set();
  const cites = (out.citations ?? []).filter((x) => {
    const k = `${x?.docId}#${x?.page}#${normalize(x?.quote ?? "")}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const valid = cites.filter((x) => quoteOnPage(c.documents, x)).length;
  return { valid, total: cites.length };
}

/** Of the gold (docId, page) sources, how many does the answer cite with a valid quote? */
export function sourceRecallScore(c, out) {
  const cited = new Set((out.citations ?? []).filter((x) => quoteOnPage(c.documents, x)).map((x) => `${x.docId}#${x.page}`));
  const gold = new Set(c.gold.sources.map((s) => `${s.docId}#${s.page}`));
  let hit = 0;
  for (const g of gold) if (cited.has(g)) hit++;
  return { hit, total: gold.size };
}

/** Facts stated (recall) and wrong distractor values stated (precision). */
export function factScore(c, out) {
  const text = out.answer ?? "";
  const factsHit = c.gold.facts.filter((f) => containsFact(text, f)).length;
  const distractorsHit = c.gold.distractors.filter((f) => containsFact(text, f) && !c.gold.facts.some((g) => sameValue(g, f))).length;
  return { factsHit, factsTotal: c.gold.facts.length, distractorsHit };
}

/** True if the two facts share a wording, or a distractor wording is part of a fact wording ("30 days" in "net 30 days"). */
function sameValue(fact, distractor) {
  const fs = (Array.isArray(fact) ? fact : [fact]).map(normalize);
  return (Array.isArray(distractor) ? distractor : [distractor]).map(normalize).some((d) => fs.some((f) => containsClaim(f, d)));
}

/** Numbers, dates and names in the answer that appear neither in its valid citation quotes nor in the question. */
export function unsupportedScore(c, out) {
  const claims = extractClaims(out.answer ?? "");
  // Claims that merely repeat the user's own question are not new assertions.
  const evidence = [c.question, ...(out.citations ?? []).filter((x) => quoteOnPage(c.documents, x)).map((x) => x.quote)].join("\n");
  const unsupported = claims.filter((k) => !containsClaim(evidence, k.text));
  return { claims: claims.length, unsupported: unsupported.map((k) => k.text) };
}

/** Trap strings that the answer text repeats. */
export function trapScore(c, out) {
  const leaked = c.gold.traps.filter((t) => containsClaim(out.answer ?? "", t));
  return { leaked, total: c.gold.traps.length };
}

/**
 * Contradiction handling: passes when the answerer abstains, or cites (validly) every gold
 * source, i.e. both conflicting documents.
 */
export function contradictionPass(c, out) {
  if (out.status === "not_found") return true;
  const s = sourceRecallScore(c, out);
  return s.total > 0 && s.hit === s.total;
}

export function scoreCase(c, out) {
  const cit = citationScore(c, out);
  const src = sourceRecallScore(c, out);
  const fact = factScore(c, out);
  const uns = unsupportedScore(c, out);
  const trap = trapScore(c, out);
  return {
    id: c.id,
    category: c.category,
    goldStatus: c.gold.status,
    status: out.error ? "error" : out.status,
    errored: Boolean(out.error),
    citations: cit,
    sources: src,
    facts: fact,
    unsupported: uns,
    traps: trap,
    contradictionPass: c.category === "contradiction" ? contradictionPass(c, out) && !out.error : null,
  };
}

const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

/** Combine per-case scores into the headline metrics (all micro-averaged except where noted). */
export function aggregate(rows) {
  const answerable = rows.filter((r) => r.goldStatus !== "not_found");
  const predictedAbstain = rows.filter((r) => r.status === "not_found");
  const goldAbstain = rows.filter((r) => r.goldStatus === "not_found");
  const abstainTP = predictedAbstain.filter((r) => r.goldStatus === "not_found").length;
  const contradictions = rows.filter((r) => r.contradictionPass !== null);
  const trapCases = rows.filter((r) => r.traps.total > 0);
  const factsHit = sum(answerable, (r) => r.facts.factsHit);
  const distractorsHit = sum(answerable, (r) => r.facts.distractorsHit);
  const claims = sum(rows, (r) => r.unsupported.claims);
  const unsupported = sum(rows, (r) => r.unsupported.unsupported.length);
  return {
    cases: rows.length,
    errors: rows.filter((r) => r.errored).length,
    citationAccuracy: ratio(sum(rows, (r) => r.citations.valid), sum(rows, (r) => r.citations.total)),
    citationsTotal: sum(rows, (r) => r.citations.total),
    sourceRecall: ratio(sum(answerable, (r) => r.sources.hit), sum(answerable, (r) => r.sources.total)),
    factualRecall: ratio(factsHit, sum(answerable, (r) => r.facts.factsTotal)),
    factualPrecision: ratio(factsHit, factsHit + distractorsHit),
    unsupportedClaimRate: ratio(unsupported, claims),
    unsupportedClaims: unsupported,
    claimsTotal: claims,
    abstentionPrecision: ratio(abstainTP, predictedAbstain.length),
    abstentionRecall: ratio(abstainTP, goldAbstain.length),
    contradictionHandling: ratio(contradictions.filter((r) => r.contradictionPass).length, contradictions.length),
    trapLeakRate: ratio(trapCases.filter((r) => r.traps.leaked.length > 0).length, trapCases.length),
    trapLeakCases: trapCases.filter((r) => r.traps.leaked.length > 0).length,
  };
}

/** Score a whole run: answers is an array of outputs aligned with cases. */
export function scoreRun(cases, answers) {
  const rows = cases.map((c, i) => scoreCase(c, answers[i]));
  const byCategory = {};
  for (const cat of [...new Set(cases.map((c) => c.category))]) {
    byCategory[cat] = aggregate(rows.filter((r) => r.category === cat));
  }
  return { overall: aggregate(rows), byCategory, rows };
}
