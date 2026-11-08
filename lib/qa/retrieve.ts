// Evidence retrieval for questions about an agreement: split the pages into short passages (each with its page),
// score them against the question, return the best few within a size budget. Lexical (BM25-style) with a small
// vocabulary of agreement terms, so "can the client end this early?" finds the termination clause. No embeddings,
// no network: deterministic and cheap, and the same passages feed the extractive answer and a model.
import { INSTRUCTION_RE, normalize } from "../understand/evidence";
import { pageText, type PageLines } from "../understand/text";

export type Passage = { id: string; page: number; text: string };
export type Scored = Passage & { score: number; coverage: number };

const STOP = new Set("a an and are as at be by can could do does for from has have how i if in is it its may me my of on or our shall should so than that the their them then there these this to under up us was we were what when where which who will with would you your about any each other into than this also".split(" "));

// groups of words that mean the same thing in an agreement; a question word pulls in its whole group
const GROUPS: string[][] = [
  ["pay", "payment", "payments", "paid", "fee", "fees", "invoice", "invoices", "payable", "price", "cost", "costs", "charge", "charges", "rate", "deposit", "retainer", "compensation", "amount", "owe", "owes", "due"],
  ["terminate", "terminates", "termination", "cancel", "cancellation", "end", "ends", "ending", "early", "notice", "expire", "expires", "expiry", "withdraw", "quit", "exit"],
  ["obligation", "obligations", "duty", "duties", "responsible", "responsibility", "must", "shall", "agrees", "required", "requirements", "deliver", "provide"],
  ["party", "parties", "between", "client", "customer", "provider", "consultant", "contractor", "supplier", "vendor", "agency", "who"],
  ["effective", "date", "dates", "start", "starts", "commence", "commencement", "begin", "begins", "term", "duration", "long", "length", "period", "renew", "renewal", "renews", "automatically"],
  ["confidential", "confidentiality", "secret", "secrets", "private", "disclose", "disclosure"],
  ["liable", "liability", "liabilities", "indemnify", "indemnity", "indemnification", "damages", "limit", "limitation", "cap"],
  ["law", "governing", "governed", "jurisdiction", "court", "courts", "dispute", "disputes", "arbitration", "venue"],
  ["sign", "signs", "signed", "signature", "signatures", "signatory", "execute", "executed", "witness", "notary"],
  ["late", "interest", "overdue", "penalty", "penalties"],
  ["intellectual", "property", "ownership", "owns", "copyright", "license", "licence"],
  ["refund", "refunds", "refundable", "money", "back"],
  ["insurance", "insure", "insured", "coverage"],
  ["data", "personal", "privacy", "gdpr", "protection"],
];
const GROUP_OF = new Map<string, number>();
GROUPS.forEach((g, i) => g.forEach((w) => GROUP_OF.set(w, i)));

const stem = (w: string) => w.replace(/(?:ations?|ation|ings?|ing|ed|es|s)$/, "") || w;
export function terms(s: string): string[] {
  return normalize(s)
    .replace(/[^\p{L}\p{N}$%]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Short passages: one or two sentences, never across pages, never over ~400 characters. */
export function passages(pages: PageLines[]): { passages: Passage[]; excluded: Passage[] } {
  const out: Passage[] = [];
  const excluded: Passage[] = [];
  for (const p of pages) {
    // every fragment is kept (a clause number like "2." too), so a passage is always a verbatim run of the page
    const sentences = pageText(p).split(/(?<=[.;!?])\s+(?=[A-Z0-9("“[])/).map((s) => s.trim()).filter(Boolean);
    let n = 0;
    for (let i = 0; i < sentences.length; i++) {
      // text addressed to software is never evidence; it's set aside on its own, so the clause next to it
      // stays usable, and the answer can mention that it was ignored
      if (INSTRUCTION_RE.test(normalize(sentences[i]))) {
        excluded.push({ id: `p${p.page}-x${i}`, page: p.page, text: sentences[i].slice(0, 400) });
        continue;
      }
      let text = sentences[i];
      // short sentences ("2. Term.") join the next one so the passage carries its meaning; never across a
      // sentence that's set aside, so a passage stays one verbatim run
      while (text.length < 120 && i + 1 < sentences.length && !INSTRUCTION_RE.test(normalize(sentences[i + 1])) && (text + " " + sentences[i + 1]).length <= 400) text += " " + sentences[++i];
      out.push({ id: `p${p.page}-${++n}`, page: p.page, text: text.slice(0, 400) });
    }
  }
  return { passages: out, excluded };
}

export type RetrieveOptions = { k?: number; maxChars?: number };

/** The passages that best match the question, best first, within the size budget. */
export function retrieve(question: string, all: Passage[], o: RetrieveOptions = {}): Scored[] {
  const k = o.k ?? 6;
  const maxChars = o.maxChars ?? 6000;
  const q = terms(question);
  if (!q.length || !all.length) return [];
  const qStems = new Set(q.map(stem));
  // a question's concepts: a synonym group, or the word itself; coverage = share of them a passage mentions
  const concept = (w: string) => (GROUP_OF.has(w) ? `g${GROUP_OF.get(w)}` : stem(w));
  const qConcepts = new Set(q.map(concept));
  const qGroups = new Set(q.map((w) => GROUP_OF.get(w)).filter((g): g is number => g !== undefined));
  const docs = all.map((p) => terms(p.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  // document frequency per stem, for idf
  const df = new Map<string, number>();
  for (const d of docs) for (const s of new Set(d.map(stem))) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s: string) => Math.log(1 + (all.length - (df.get(s) ?? 0) + 0.5) / ((df.get(s) ?? 0) + 0.5));
  const scored = all.map((p, i) => {
    const d = docs[i];
    const norm = 1.2 * (0.25 + 0.75 * (d.length / avg));
    let score = 0;
    const tf = new Map<string, number>();
    for (const w of d) {
      const s = stem(w);
      const hit = qStems.has(s) ? 1 : qGroups.has(GROUP_OF.get(w) ?? -1) ? 0.6 : 0; // exact beats synonym
      if (hit) tf.set(s, (tf.get(s) ?? 0) + hit);
    }
    for (const [s, f] of tf) score += idf(s) * ((f * 2.2) / (f + norm));
    const have = new Set(d.map(concept));
    const coverage = [...qConcepts].filter((c) => have.has(c)).length / qConcepts.size;
    return { ...p, score, coverage };
  });
  const out: Scored[] = [];
  let used = 0;
  for (const p of scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)) {
    if (out.length >= k || used + p.text.length > maxChars) break;
    out.push(p);
    used += p.text.length;
  }
  return out;
}
