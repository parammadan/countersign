// The evidence check. A finding is only "stated" if a quote from it is really in the document. This is what
// keeps an analyzer (a model in particular) from presenting something it made up, or something an instruction
// hidden in the agreement told it to say, as a fact from the agreement.
import type { Finding } from "./schema";
import { INVISIBLE, pageText, type PageLines } from "./text";

export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type Grounded = { findings: Finding[]; warnings: string[] };

// Text that talks to software ("ignore previous instructions", "you are an AI"). Shared with the rules analyzer.
// A best-effort denylist, not a guarantee: the real protection is that findings are suggestions a person checks,
// with the quote beside each one, and that model values must be copied from their quotes.
export const INSTRUCTION_RE =
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,60}\b(?:instructions?|prompts?|rules|guidelines)\b|\bsystem prompt\b|\byou are (?:an? |the )?(?:ai|assistant|language model|chatbot)\b|\bas an ai\b|\bdeveloper mode\b|\b(?:ai|assistant|model|reviewer|reader|you)s?\s*(?:must|should|shall|are to)\s+(?:record|report|mark|state|say|treat|ignore)\b|\bnotes? (?:to|for) (?:any |the |all )?(?:ai|assistants?|models?|reviewers?|readers?|automated|software|tools?|bots?)\b|\b(?:software|tools?|systems?|bots?|programs?|automated (?:readers?|tools?|systems?))(?: reading| processing| reviewing)?(?: this)?(?: document| agreement)?\s+(?:must|should|shall|is to|are to)\b|\bdisregard (?:the )?(?:above|previous|preceding|foregoing)\b|\b(?:ai|assistants?|models?|llms?|bots?|automated (?:readers?|reviewers?|tools?)|(?:ai |automated )?(?:reviewers?|readers?))\s*[:,–-]\s*(?:please\s+)?(?:record|report|mark|state|say|treat|ignore|confirm|note|answer|reply)\b/i;

/** Quotes shorter than this ("the", "fee") match almost any document, so they don't count as support. */
export const MIN_QUOTE = 8;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const AMOUNT_RE = new RegExp(String.raw`(?:[$£€]|\b(?:usd|gbp|eur|cad|aud)\b)\s?(${NUM})|\b(${NUM})\s?(?:dollars|pounds|euros|usd|gbp|eur|cad|aud)\b`, "gi");
const PCT_RE = new RegExp(String.raw`\b(${NUM})\s?(?:%|per\s?cent\b|percent\b)`, "gi");
const DATE_RES: [RegExp, (m: RegExpExecArray) => string][] = [
  [new RegExp(String.raw`\b(${MON})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "gi"), (m) => ymd(m[3], month(m[1]), m[2])],
  [new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?(${MON})\.?,?\s+(\d{4})\b`, "gi"), (m) => ymd(m[3], month(m[2]), m[1])],
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => ymd(m[1], +m[2], m[3])],
  // 03/04/2026 is March 4 or 3 April depending on the country: compared as written, never converted
  [/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g, (m) => `n:${+m[1]}/${+m[2]}/${m[3]}`],
];
const month = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;
const ymd = (y: string, m: number, d: string) => `d:${y}-${String(m).padStart(2, "0")}-${String(+d).padStart(2, "0")}`;
const num = (s: string) => String(Number(s.replace(/,/g, "")));

/** The facts in a piece of text that must be copied, not made up: amounts, percentages and dates, in one form. */
export function hardTokens(text: string): Map<string, string> {
  const s = text.normalize("NFKC").replace(INVISIBLE, "");
  const out = new Map<string, string>();
  for (const m of s.matchAll(AMOUNT_RE)) out.set(`a:${num(m[1] ?? m[2])}`, m[0]);
  for (const m of s.matchAll(PCT_RE)) out.set(`p:${num(m[1])}`, m[0]);
  for (const [re, canon] of DATE_RES) for (const m of s.matchAll(re)) out.set(canon(m as RegExpExecArray), m[0]);
  return out;
}

/** Amounts, percentages and dates in a value that none of its quotes contain (compared exactly, not as substrings). */
export function unsupportedTokens(value: string | null, quotes: string[]): string[] {
  if (!value) return [];
  const have = new Set(quotes.flatMap((q) => [...hardTokens(q).keys()]));
  return [...hardTokens(value)].filter(([k]) => !have.has(k)).map(([, raw]) => raw);
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "called", "agreement", "party", "parties", "client", "provider", "firm", "company", "inc", "llc", "ltd", "llp", "corp", "co"]);
/** Words of a value that its quotes don't contain. Used where values must be copied from the document (model output). */
export function unsupportedWords(value: string | null, quotes: string[]): string[] {
  if (!value) return [];
  const hay = " " + quotes.map((q) => normalize(q).replace(/[^\p{L}\p{N}]+/gu, " ")).join(" ") + " ";
  return [...new Set(normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").split(" "))].filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !hay.includes(` ${w} `));
}

export type GroundOptions = { /** values must be extractive: every significant word appears in a quote (model output) */ strict?: boolean };

export function groundFindings(findings: Finding[], pages: PageLines[], opts: GroundOptions = {}): Grounded {
  const texts = pages.map((p) => ({ page: p.page, text: normalize(pageText(p)) }));
  const warnings: string[] = [];
  let dropped = 0;
  let downgraded = 0;
  let laundered = 0;
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    let id = f.id;
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`.slice(0, 48);
    seen.add(id);
    const evidence: Finding["evidence"] = [];
    for (const e of f.evidence) {
      const q = normalize(e.quote);
      if (q.length < MIN_QUOTE) {
        dropped++;
        continue;
      }
      // on the page it names, or else on whichever page it's really on
      const hit = texts.find((t) => t.page === e.page && t.text.includes(q)) ?? texts.find((t) => t.text.includes(q));
      if (!hit) {
        dropped++;
        continue;
      }
      if (!evidence.some((x) => x.page === hit.page && normalize(x.quote) === q)) evidence.push({ page: hit.page, quote: e.quote.trim() });
    }
    let status = f.status;
    let note = f.note;
    if (status === "stated" && evidence.length === 0) {
      status = "inferred";
      note = "No supporting text was found in the document, so this isn't confirmed.";
      downgraded++;
    } else if (status === "stated" && f.category === "parties" && f.value && unsupportedWords(f.value.split(/,\s*called\b/)[0], evidence.map((e) => e.quote)).length) {
      // every word of a name must be in its own quote
      status = "inferred";
      note = "The quoted text doesn't contain this name, so it isn't confirmed.";
      downgraded++;
    } else if (status === "stated" && opts.strict && unsupportedWords(f.value, evidence.map((e) => e.quote)).length) {
      status = "inferred";
      note = "The quoted text doesn't say this in so many words, so it isn't confirmed.";
      downgraded++;
    } else if (status === "stated" && unsupportedTokens(f.value, evidence.map((e) => e.quote)).length) {
      // a real quote attached to a value it doesn't contain ("$5,000" quoting a sentence about $500)
      status = "inferred";
      note = `The quoted text doesn't contain ${unsupportedTokens(f.value, evidence.map((e) => e.quote)).join(", ")}, so this isn't confirmed.`;
      downgraded++;
    }
    if (f.category !== "gaps" && status !== "missing" && evidence.some((e) => INSTRUCTION_RE.test(normalize(e.quote)))) {
      // quote laundering: a sentence planted in the agreement, quoted as support for what it tells the reader to say
      status = "ambiguous";
      note = "The supporting text reads like an instruction to software, not an agreement term. Check the document.";
      laundered++;
    }
    out.push({ ...f, id, status, note, evidence, value: status === "missing" ? null : f.value });
  }
  if (dropped) warnings.push(`${dropped} quoted passage${dropped === 1 ? " wasn't" : "s weren't"} found in the document and ${dropped === 1 ? "was" : "were"} removed.`);
  if (downgraded) warnings.push(`${downgraded} finding${downgraded === 1 ? " was" : "s were"} marked inferred because nothing in the document supports ${downgraded === 1 ? "it" : "them"}.`);
  if (laundered) warnings.push(`${laundered} finding${laundered === 1 ? " relies" : "s rely"} on text that reads like an instruction to software and ${laundered === 1 ? "was" : "were"} marked unclear.`);
  return { findings: out, warnings };
}
