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
export const INSTRUCTION_RE =
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,60}\b(?:instructions?|prompts?|rules|guidelines)\b|\bsystem prompt\b|\byou are (?:an? |the )?(?:ai|assistant|language model|chatbot)\b|\bas an ai\b|\bdeveloper mode\b|\b(?:ai|assistant|model|reviewer|reader|you)s?\s*(?:must|should|shall|are to)\s+(?:record|report|mark|state|say|treat|ignore)\b|\bnote to (?:any |the |all )?(?:ai|assistants?|models?|reviewers?|readers?|automated)\b/i;

/** Quotes shorter than this ("the", "fee") match almost any document, so they don't count as support. */
export const MIN_QUOTE = 8;

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
// the parts of a value that must be copied from the document, not made up: amounts, percentages, dates
const HARD_TOKEN = new RegExp(`[$£€]\\s?\\d[\\d,]*(?:\\.\\d+)?|\\b\\d+(?:\\.\\d+)?\\s?%|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(?:${MONTHS})\\.?,?\\s+\\d{4}|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "gi");
const digitsOf = (s: string) => normalize(s).replace(/[^0-9a-z%$£€]/g, "");

/** Amounts, percentages and dates in a value that none of its quotes contain. */
export function unsupportedTokens(value: string | null, quotes: string[]): string[] {
  if (!value) return [];
  const hay = quotes.map(digitsOf).join("|");
  return (value.match(HARD_TOKEN) ?? []).filter((tok) => !hay.includes(digitsOf(tok)));
}

export function groundFindings(findings: Finding[], pages: PageLines[]): Grounded {
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
    } else if (status === "stated" && f.category === "parties" && f.value && !evidence.some((e) => normalize(e.quote).includes(normalize(f.value!.split(/[,(“"]/)[0]).split(" ")[0]))) {
      // a name must be in its own quote
      status = "inferred";
      note = "The quoted text doesn't contain this name, so it isn't confirmed.";
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
