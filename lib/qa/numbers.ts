// Reading numbers in agreements, answers and claims the same way everywhere: digits of any script, spelled-out
// numbers ("thirty (30)", "two thousand five hundred", "a dozen"), thousands separators.
import { normalize } from "../understand/evidence";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALE: Record<string, number> = { dozen: 12, hundred: 100, thousand: 1000, million: 1_000_000 };
export const NUMWORD = [...ONES, ...TENS.filter(Boolean), ...Object.keys(SCALE)].join("|");
const NUMWORD_RUN = new RegExp(`\\b(?:${NUMWORD})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMWORD}))*\\b`, "g");
/** Spelled-out numbers as digits ("two thousand five hundred" -> "2500"), on normalized text. */
function digitize(s: string): string {
  return s.replace(NUMWORD_RUN, (run, at: number) => {
    // "one" alone is usually a pronoun ("the one who", "no one"); it's the number 1 only before a unit
    if (run === "one" && !/^\s*(?:\(1\)\s*)?(?:(?:additional|further|more|extra|full|single|separate)\s+)?(?:hour|day|week|month|year|percent|dollar|business|calendar|working|invoice|time|instalment|installment|term|renewal|period|extension|copy|copies|user|location|seat|licen[cs]e|payment|site|visit|round|revision|milestone|session|unit|item|page|image)(?:s|es)?\b/.test(s.slice(at + 3, at + 40))) return run;
    let cur = 0, total = 0;
    for (const w of run.split(/[\s-]+/)) {
      if (ONES.includes(w)) cur += ONES.indexOf(w);
      else if (TENS.includes(w)) cur += TENS.indexOf(w) * 10;
      else if (w === "hundred") cur = (cur || 1) * 100;
      else if (SCALE[w]) { total += (cur || 1) * SCALE[w]; cur = 0; }
    }
    return String(total + cur);
  });
}
// clause numbers ("2. Term.", "4.1 Fees"): stripped from the passages before number/unit pairs are read, so
// "within 2 days" can't lean on clause 2; never stripped from the answer
// a label has a dot ("2. Term", "4.1 Fees"); "on 20 Business Days' notice" keeps its 20
export const stripClauses = (raw: string) => raw.replace(/(^|\s)\d{1,3}\.(?:\d{1,3}\.?)*(?=\s+[A-Z(“"])/g, "$1");
// references to a clause ("clause 6.2", "Section 4.5(b)", "Schedule 3"): a label, not a figure
export const stripRefs = (raw: string) =>
  raw.replace(/\b(?:clauses?|sections?|schedules?|exhibits?|annex(?:es)?|appendix|appendices|paragraphs?|articles?|parts?|sub-?clauses?)\s+[A-Z]?\d{1,3}(?:\.\d{1,3})*(?:\s*\([a-z0-9]{1,4}\))*(?:\s*(?:,|and|or|to|-|–)\s*[A-Z]?\d{1,3}(?:\.\d{1,3})*(?:\s*\([a-z0-9]{1,4}\))*(?![\d.,-]*\s*(?:%|per\b|percent|-?\s*(?:days?|weeks?|months?|years?|hours?|minutes?)|business|calendar|working|times\b|dollars?|pounds?|euros?|usd|gbp|eur|[$£€])))*/gi, " ");
// ("clause 2 or 60 days" keeps its 60: a number followed by a unit isn't another clause)
// digits of any script as ASCII ("٢" -> "2"); NFKC already folds fullwidth and mathematical digits
const asciiDigits = (s: string) =>
  s.replace(/\p{Nd}/gu, (d) => {
    let cp = d.codePointAt(0)!;
    let k = 0;
    while (k < 60 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) { cp--; k++; }
    return String((d.codePointAt(0)! - cp) % 10);
  });
// bounded: answers and passages are short, and the number patterns are kept away from pathological input
export const MAX_FACT_TEXT = 6000;
export const prep = (raw: string) => digitize(asciiDigits(normalize(raw.slice(0, MAX_FACT_TEXT))));
/** Every number in a text, digits or words ("thirty (30)", "two thousand five hundred", "3rd"), as canonical strings. */
export function numbersIn(text: string): Set<string> {
  return new Set([...prep(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => String(Number(m[0].replace(/,/g, "")))));
}

/** Every number in a text of any length (numbersIn reads a bounded prefix): read sentence by sentence. */
export function numbersInAll(text: string): Set<string> {
  const out = new Set<string>();
  let chunk = "";
  for (const s of text.split(/(?<=[.!?;\n])\s+/)) {
    if (chunk.length + s.length > MAX_FACT_TEXT - 10 && chunk) {
      for (const n of numbersIn(chunk)) out.add(n);
      chunk = "";
    }
    // a single over-long sentence is read in pieces cut at spaces
    if (s.length > MAX_FACT_TEXT - 10) {
      for (const piece of s.match(/[\s\S]{1,4000}(?:\s|$)/g) ?? [s]) for (const n of numbersIn(piece)) out.add(n);
      continue;
    }
    chunk += (chunk ? " " : "") + s;
  }
  for (const n of numbersIn(chunk)) out.add(n);
  return out;
}

