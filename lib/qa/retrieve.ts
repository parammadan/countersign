// Evidence retrieval for questions about an agreement: split the pages into short passages (each with its page),
// score them against the question, return the best few within a size budget. Lexical (BM25-style) with a small
// vocabulary of agreement terms, so "can the client end this early?" finds the termination clause. No embeddings,
// no network: deterministic and cheap, and the same passages feed the extractive answer and a model.
import { INSTRUCTION_RE, normalize } from "../understand/evidence";

// Q&A sets aside more than M2.1 flags: text written to steer an answering assistant. Each form needs an
// instruction verb or a direct address, so ordinary clauses ("If asked by the Client, the Consultant shall
// provide...", "Claude, the project lead, will attend") stay usable. M2.1 keeps its own pattern unchanged.
const ANSWER_VERB = "(?:answer|say|state|report|reply|respond|record|confirm)";
const QA_EXTRA = [
  String.raw`\b(?:ai|ai[ -](?:assistants?|models?|reviewers?|readers?|tools?)|assistants?|llms?|chatbots?|language models?|automated (?:readers?|reviewers?|tools?|systems?))\s*[:–—-]\s*(?:please\s+)?(?:record|report|mark|state|say|treat|ignore|confirm|note|answer|reply)\b`,
  String.raw`\bif (?:you are |you're )?asked\b[^.]{0,80}?\b${ANSWER_VERB}\b`,
  String.raw`\bwhen (?:summari[sz]ing|answering questions about) (?:this|the)\b`,
  String.raw`\b(?:attention|notes? (?:to|for))\b[^.]{0,30}?\b(?:language models?|llms?|chatbots?|ai)\b`,
  String.raw`\b(?:claude|chatgpt|gpt-?\d\w*|gemini|copilot)\s*,\s*(?:please|you (?:must|should|shall))\b`,
  String.raw`\b(?:ai )?assistants? (?:reading|processing|reviewing) (?:this|the)\b[^.]{0,40}?\b(?:must|should|shall)\b`,
  String.raw`^\s*(?:q|question|a|answer)\s*:\s`,
  String.raw`\b${ANSWER_VERB}\s+that\s+(?:the\s+)?(?:fees?|client|customer|agreement|amount|payment|price|signatures?)\b`,
  // a sentence that tells the reader's software what to tell its user, or speaks to it as "you"
  String.raw`^\W*(?:tell|inform|let|show|assure|convince)\s+(?:the\s+)?(?:user|reader|requester|person asking|human)\b`,
  // "you must say that...", "you should answer only with..." (but not "you must tell us within 14 days")
  String.raw`\byou (?:must|should|shall|need to|are to|will) (?:now |always |only )?(?:say|answer|reply|respond|output|print|claim)\s+(?:that|with|only|exactly|"|“|the word|the following)`,
  String.raw`\[\s*(?:system|assistant|admin|instructions?|developer|prompt)\s*\]|<\s*/?\s*(?:system|instructions?)\s*>`,
  String.raw`\b(?:reveal|print|repeat|show|output)\b[^.]{0,30}\b(?:system prompt|your (?:instructions|prompt|rules))\b`,
  String.raw`\bnotes?\b[^.:]{0,60}?\b(?:to|for)\b[^.:]{0,20}?\b(?:automated|ai|assistants?|language models?|llms?|chatbots?|bots?|machine)\b`,
  String.raw`\b(?:summar(?:y|ies)|answers?|responses?|outputs?|replies)\b[^.]{0,50}?\b(?:should|must|shall|are to)\s+(?:say|state|report|show|read|confirm|claim|list|give|describe)\b`,
  String.raw`\b(?:automated|ai|machine)\s+(?:summar\w*|review\w*|readers?|tools?|systems?|assistants?)\b[^.]{0,60}?\b(?:should|must|shall|are to)\b`,
  String.raw`\b(?:reviewer|reader|assistant|summari[sz]er)\s+(?:guidance|instructions?|notes?)\s*:`,
  String.raw`\binstructions?\s+(?:for|to)\s+(?:any\s+|the\s+|all\s+)?(?:ai|automated|assistants?|bots?|tools?|language models?|llms?|chatbots?)\b`,
  String.raw`\b(?:for|to)\s+(?:any|all|the|every)\s+(?:ai|assistants?|bots?|language models?|llms?|chatbots?|automated \w+)\b[^.]{0,30}?\b(?:reading|processing|reviewing|summari[sz]ing|parsing)\b`,
].join("|");
export const QA_INSTRUCTION_RE = new RegExp(`${INSTRUCTION_RE.source}|${QA_EXTRA}`, "i");

/**
 * Text the agreement itself labels as not part of its terms. A heading-style label ("Marketing summary:",
 * "Superseded draft terms", "Unofficial FAQ") opens a section that runs to the next numbered clause, schedule
 * heading or capitalised heading, across pages; a parenthetical label ("(non-binding)") covers only its own sentence.
 * Neither is evidence; the reader is told it was set aside.
 */
// "Schedule C", "Section 5", "Exhibit IV" (with an identifier), or a heading in capitals ("GENERAL TERMS")
const KEYWORD_HEADING = /^\s*(?:schedule|appendix|exhibit|annex|article|section|part)\s+(?:[a-z]|\d{1,3}|[ivx]{1,5})(?:[.:)\s]|$)/i;
const CAPS_HEADING = /^\s*[A-Z][A-Z &,'-]{3,60}[.:]?$/;
// a keyword line is a heading only when short ("Schedule D.", "Section 5: Fees"), not "Section 4 of the draft set..."
const isHeading = (t: string) => (KEYWORD_HEADING.test(t) && t.split(/\s+/).length <= 8) || CAPS_HEADING.test(t);
export const NON_BINDING_SECTION_RE = /^(?:[a-z][\w ]{0,30}\.\s+)?(?:marketing (?:summary|copy|material|overview)|unofficial (?:faq|summary|notes?|guide|overview)|superseded (?:drafts?|versions?|terms)|draft (?:summary|version|terms|overview)|faq|sales (?:summary|sheet))\b/i;
export const NON_BINDING_SENTENCE_RE = /\((?:not (?:legally )?binding|non-binding|unofficial|superseded|draft only|for discussion only)\)/i;
export const NON_BINDING_RE = new RegExp(`${NON_BINDING_SECTION_RE.source}|${NON_BINDING_SENTENCE_RE.source}`, "i");
import { pageText, type PageLines } from "../understand/text";

/** `seq`: position in the document. `binding: false`: text the agreement labels as not part of its terms. */
export type Passage = { id: string; page: number; text: string; seq?: number; binding?: false };
export type Scored = Passage & { score: number; coverage: number };

const STOP = new Set("a an and are as at be by can could do does for from has have how i if in is it its may me my of on or our shall should so than that the their them then there these this to under up us was we were what when where which who will with would you your about any each other into than this also".split(" "));

// groups of words that mean the same thing in an agreement; a question word pulls in its whole group
const GROUPS: string[][] = [
  ["pay", "payment", "payments", "paid", "fee", "fees", "invoice", "invoices", "payable", "price", "cost", "costs", "charge", "charges", "rate", "deposit", "retainer", "compensation", "amount", "owe", "owes", "owed", "owing", "due"],
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
const GENERIC = new Set(["agreement", "agreements", "contract", "contracts", "document", "documents", "letter", "terms", "clause", "clauses", "section", "include", "includes", "say", "says", "state", "states", "mention", "mentions", "tell", "anything", "there", "much", "many", "need", "needed", "needs", "happen", "happens", "get", "gets", "allowed", "able", "possible", "specific", "exactly", "kind", "type", "apply", "applies", "give", "given", "know", "explain", "actually"]);
export const GROUP_OF = new Map<string, number>();
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
  let unofficial = false;
  let sectionItem = 0;
  let lastClause = 0;
  let seq = 0;
  for (const p of pages) {
    // every fragment is kept (a clause number like "2." too), so a passage is always a verbatim run of the page
    const sentences = pageText(p).split(/(?<=[.;!?])\s+(?=[A-Z0-9("“[])/).map((s) => s.trim()).filter(Boolean);
    // set aside, sentence by sentence: text addressed to software ("x"), and text the agreement labels as not part
    // of its terms ("n"). A heading-like label ("Superseded draft terms (withdrawn).", "Marketing summary: ...")
    // opens a section that runs, across pages, to the next schedule or ALL-CAPS heading or the next main clause
    // (a number above the agreement's last clause; items numbered from 1 again belong to the section).
    const aside: ("x" | "n" | null)[] = [];
    let prev = "";
    for (const t of sentences) {
      const n = normalize(t);
      // a clause label is a number with a period or bracket ("4.", "4.1", "(4)"), not "30 days' notice is required"
      const num = Number((/^\s*\(?(\d{1,3})(?:\.\d{1,3})*[.)](?:\s|$)/.exec(t) ?? [])[1] ?? NaN);
      // a label sentence is itself set aside; it opens a section only when it's a heading: short with nothing after
      // a colon, ending in a colon, or right after a heading ("Schedule C.")
      const label = NON_BINDING_SECTION_RE.test(n);
      const afterHeading = prev !== "" && (isHeading(prev) || prev.split(/\s+/).length <= 3);
      // an FAQ is questions and answers: its label opens a section even with a subtitle ("Unofficial FAQ: answers...")
      const headingLike = /:\s*$/.test(t) || (t.split(/\s+/).length <= 8 && (!/:\s*\S/.test(t) || /\bfaq\b/.test(n))) || afterHeading;
      prev = t;
      if (label && headingLike) {
        if (!unofficial) sectionItem = 0;
        unofficial = true;
      } else if (unofficial && !label) {
        // the section keeps its own numbering ("1.", "2." of a superseded schedule); a number that isn't its next
        // item and is above the agreement's last clause means the agreement has resumed
        if (isHeading(t) || (num > 0 && num > lastClause && num > sectionItem + 1)) unofficial = false;
        else if (num > 0) sectionItem = Math.max(sectionItem, num);
      }
      if (!unofficial && !label && num > 0) lastClause = Math.max(lastClause, num);
      aside.push(QA_INSTRUCTION_RE.test(n) ? "x" : unofficial || label || NON_BINDING_SENTENCE_RE.test(n) ? "n" : null);
    }
    let n = 0;
    for (let i = 0; i < sentences.length; i++) {
      // never evidence; set aside on its own, so the clause next to it stays usable, and the answer can mention it
      if (aside[i]) {
        excluded.push({ id: `p${p.page}-${aside[i]}${i}`, page: p.page, text: sentences[i].slice(0, 400), seq: seq++, ...(aside[i] === "n" ? { binding: false as const } : {}) });
        continue;
      }
      let text = sentences[i];
      // short sentences ("2. Term.") join the next one so the passage carries its meaning; never across a
      // sentence that's set aside, so a passage stays one verbatim run
      while (text.length < 120 && i + 1 < sentences.length && !aside[i + 1] && (text + " " + sentences[i + 1]).length <= 400) text += " " + sentences[++i];
      out.push({ id: `p${p.page}-${++n}`, page: p.page, text: text.slice(0, 400), seq: seq++ });
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
  // a question's concepts: a synonym group, or the word itself; coverage = share of them a passage mentions.
  // Names ("the Alder Row Legal agreement") and words like "agreement" say which document, not what about it,
  // so they don't count toward coverage (they still score).
  const concept = (w: string) => (GROUP_OF.has(w) ? `g${GROUP_OF.get(w)}` : stem(w));
  const names = new Set(
    [...question.normalize("NFKC").matchAll(/(?<=\S\s+)([A-Z][\p{L}'’&-]*)/gu)].map((m) => normalize(m[1]).replace(/'s$/, "")).filter((w) => !GROUP_OF.has(w)),
  );
  const topical = q.filter((w) => !names.has(w) && !GENERIC.has(w));
  const qConcepts = new Set((topical.length ? topical : q).map(concept));
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

