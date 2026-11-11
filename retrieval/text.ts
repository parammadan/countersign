/** Text helpers: tokenizing, a small agreement-term synonym map, verbatim chunking, value extraction. */

const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its of on or our shall " +
    "should so than that the their then there these they this to under was we what when where which who will " +
    "with within without would you your per any all not no").split(" "),
);

/** canonical term -> words that mean the same thing in an agreement. Applied to documents and queries alike. */
const SYNONYM_GROUPS: Record<string, string[]> = {
  terminat: ["terminate", "termination", "cancel", "cancellation", "cancelled", "canceled", "rescind"],
  payment: ["pay", "paid", "payable", "invoice", "invoiced", "fee", "remuneration", "compensation", "charge"],
  confiden: ["confidential", "confidentiality", "nondisclosure", "nda", "secrecy", "secret"],
  liabil: ["liability", "liable", "indemnify", "indemnification", "indemnity"],
  renew: ["renew", "renewal", "extend", "extension"],
  retent: ["retain", "retention", "retained", "keep", "preserve"],
  dispute: ["dispute", "arbitration", "arbitrate", "litigation"],
  jurisdic: ["jurisdiction", "governing", "governed", "govern", "venue"],
  employee: ["employee", "staff", "personnel", "worker"],
  leave: ["leave", "vacation", "holiday", "pto"],
  expense: ["expense", "reimbursement", "reimburse", "expenditure"],
  deliver: ["deliverable", "deliver", "milestone", "delivery"],
  notice: ["notice", "notify", "notification", "inform", "informed", "told"],
  requir: ["require", "required", "requirement", "mandatory"],
  breach: ["breach", "violation", "default"],
};

const SYNONYM = new Map<string, string>();
for (const [canon, words] of Object.entries(SYNONYM_GROUPS)) {
  SYNONYM.set(canon, canon);
  for (const w of words) SYNONYM.set(w, canon);
}

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function normalizeToken(raw: string): string {
  const direct = SYNONYM.get(raw);
  if (direct) return direct;
  const s = stem(raw);
  return SYNONYM.get(s) ?? s;
}

/** Lowercased, stopword-free, synonym-normalised terms in order of appearance (duplicates kept). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  // Accents are folded (Zürich -> zurich); other scripts tokenize as whole letter runs, with no word segmentation.
  const folded = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  for (const m of folded.matchAll(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu)) {
    const w = m[0].replace(/,/g, "");
    if (STOPWORDS.has(w)) continue;
    out.push(normalizeToken(w));
  }
  return out;
}

export type Span = { start: number; end: number };
export type RawChunk = { start: number; end: number; text: string; sentences: Span[] };

/** Sentence spans of a page, trimmed of whitespace. Every span indexes the original string. */
export function sentenceSpans(page: string): Span[] {
  const spans: Span[] = [];
  for (const m of page.matchAll(/[^.!?\n]+(?:[.!?]+(?=\s|$)|(?=\n)|$)/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = (m.index ?? 0) + lead;
    spans.push({ start, end: start + trimmed.length });
  }
  return spans;
}

/**
 * Chunks one page into contiguous runs of whole sentences of at most ~`maxChars`. `text` is always
 * `page.slice(start, end)`, so it is verbatim, and chunks never cross a page because each page is chunked alone.
 */
export function chunkPage(page: string, maxChars = 420): RawChunk[] {
  const spans = sentenceSpans(page);
  const chunks: RawChunk[] = [];
  let group: Span[] = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    chunks.push({
      start,
      end,
      text: page.slice(start, end),
      sentences: group.map((s) => ({ start: s.start - start, end: s.end - start })),
    });
    group = [];
  };
  for (const s of spans) {
    if (group.length && s.end - group[0].start > maxChars) flush();
    group.push(s);
  }
  flush();
  return chunks;
}

export type Value = { amount: string; unit: string };

/** Quantities with a unit or currency ("30 days", "$5,000", "12%"): what two documents can disagree about. */
export function extractValues(sentence: string): Value[] {
  const out: Value[] = [];
  const re = /([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|percent|business days?|days?|weeks?|months?|years?|hours?)?/gi;
  for (const m of sentence.matchAll(re)) {
    const cur = m[1];
    const unitRaw = (m[3] ?? "").toLowerCase();
    if (!cur && !unitRaw) continue;
    const unit = cur ? cur : unitRaw === "percent" ? "%" : unitRaw.replace(/^business /, "").replace(/s$/, "");
    out.push({ amount: m[2].replace(/,/g, "").replace(/\.0+$/, ""), unit });
  }
  return out;
}
