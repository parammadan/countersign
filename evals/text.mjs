// Text helpers shared by the metrics and the baselines. Pure, deterministic, no dependencies.

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "g");
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
// Two or more capitalised words in a row ("Alder Row Legal"), or a capitalised word that does not start a sentence.
const NAME_SEQ_RE = /\b[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*)+\b/g;
const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;
const NAME_STOP = new Set(["I", "The", "A", "An", "If", "In", "On", "At", "Both", "This", "That", "These", "Those", "It"]);

/** Lowercase, straighten quotes and dashes, drop thousands commas, collapse whitespace. */
export function normalize(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/(?<=\d),(?=\d{3}\b)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `needle` occurs in `haystack`; numeric needles must not be part of a longer number. */
export function containsClaim(haystack, needle) {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return false;
  if (/^[$\d]/.test(n) || /\d$/.test(n)) {
    return new RegExp(`(?<!\\d|\\d\\.)${escapeRe(n)}(?![\\d]|\\.\\d)`).test(h);
  }
  return new RegExp(`(?<![a-z0-9])${escapeRe(n)}(?![a-z0-9])`).test(h);
}

/** True if the answer states the fact (string, or any of an array of wordings). */
export function containsFact(answer, fact) {
  return (Array.isArray(fact) ? fact : [fact]).some((f) => containsClaim(answer, f));
}

/**
 * Concrete claims an answer makes: dates, numbers and names. Returned as { kind, text }.
 * Heuristic by design: it catches invented figures and names, not paraphrased reasoning.
 */
export function extractClaims(answer) {
  const claims = [];
  const seen = new Set();
  const add = (kind, text) => {
    const key = `${kind}:${normalize(text)}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push({ kind, text });
    }
  };
  let rest = String(answer);
  for (const m of rest.matchAll(DATE_RE)) add("date", m[0]);
  rest = rest.replace(DATE_RE, " ");
  for (const m of rest.matchAll(NUMBER_RE)) add("number", m[0].replace(/[.,]+$/, ""));
  rest = rest.replace(NUMBER_RE, " ");
  for (const m of rest.matchAll(NAME_SEQ_RE)) {
    const words = m[0].split(/\s+/);
    while (words.length && NAME_STOP.has(words[0])) words.shift();
    if (words.length >= 2) add("name", words.join(" "));
    else if (words.length === 1 && !NAME_STOP.has(words[0])) add("name", words[0]);
  }
  // Single capitalised words that are not sentence-initial.
  for (const sentence of rest.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.match(WORD_RE) ?? [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (/^[A-Z][a-z]/.test(w) && !NAME_STOP.has(w) && !/\s/.test(w)) add("name", w);
    }
  }
  return claims;
}

const STOP = new Set(
  "a an and are as at be by does do for from has have how in is it of on or that the their there this to under what when where which who whose will with within my our your any can may must per".split(" "),
);

export function tokens(s) {
  return (normalize(s).match(/[a-z0-9$%][a-z0-9$%'-]*/g) ?? []).filter((t) => !STOP.has(t));
}

/** Split a page into sentence-like passages, in order. */
export function passages(page) {
  return String(page)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
