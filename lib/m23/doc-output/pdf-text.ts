// Which characters the PDF renderer can print. It uses the standard Helvetica fonts, which only encode WinAnsi.
// A few typographic characters outside WinAnsi (dash and quote variants, Unicode spaces, ligatures) are printed as
// their WinAnsi equivalent, which reads the same (pdfEquivalents). Anything else would be printed as "?" (see
// winAnsi in pdf.ts), so callers use pdfTextProblem to refuse such a document before approval, publishing or export,
// instead of publishing "?ukasz Nowak". Follow-up: embed a Unicode font so this limit goes away.
import type { DraftDocument } from "./types";
import { cleanText } from "./validate";

/**
 * Typographic characters the standard fonts lack, and the WinAnsi text printed for them. Only characters whose
 * equivalent reads the same: dashes, quotes, primes, spaces, and ligatures spelled out as their letters. No other
 * letter, digit, currency sign or symbol is ever swapped (those are refused by pdfTextProblem).
 */
export const PDF_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze({
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u2012": "\u2013", // figure dash -> en dash
  "\u2015": "\u2014", // horizontal bar -> em dash
  "\u2212": "-", // minus sign -> hyphen-minus
  "\u201B": "\u2018", // reversed single quotation mark
  "\u201F": "\u201C", // reversed double quotation mark
  "\u2032": "'", // prime
  "\u2033": '"', // double prime
  "\u2000": " ", "\u2001": " ", "\u2002": " ", "\u2003": " ", "\u2004": " ", "\u2005": " ", "\u2006": " ", // en/em spaces
  "\u2008": " ", "\u2009": " ", "\u200A": " ", "\u205F": " ", // punctuation, thin, hair, medium mathematical space
  "\u2007": "\u00A0", // figure space (no break) -> no-break space
  "\u202F": "\u00A0", // narrow no-break space ("10\u202F000 \u20AC") -> no-break space
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB06": "st", // Latin ligatures
});
const EQUIVALENT_RE = new RegExp(`[${Object.keys(PDF_EQUIVALENTS).join("")}]`, "g");

/** s with each character in PDF_EQUIVALENTS replaced by its WinAnsi equivalent; every other character is kept. */
export function pdfEquivalents(s: string): string {
  return s.replace(EQUIVALENT_RE, (ch) => PDF_EQUIVALENTS[ch]);
}

/** WinAnsi (Windows-1252) characters outside ASCII and Latin-1 (0x80-0x9F block). */
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** True when the PDF's standard fonts can print this character (tab and line breaks are handled by the renderer). */
export function pdfCanPrint(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  if (ch === "\t" || ch === "\n" || ch === "\r") return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return CP1252_EXTRA.includes(ch);
}

/** Distinct characters in s the PDF cannot print, after the cleaning both renderers apply and the PDF equivalents. */
export function unprintableChars(s: string): string[] {
  return [...new Set([...pdfEquivalents(cleanText(s))].filter((ch) => !pdfCanPrint(ch)))];
}

const show = (chs: string[]) => chs.map((ch) => `${ch} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ");

/**
 * null when every string the PDF prints is encodable; otherwise names the first field with unprintable
 * characters and lists them, e.g. `party 1 name: cannot print Ł (U+0141)`.
 */
export function pdfTextProblem(doc: DraftDocument): string | null {
  const fields: [string, string | undefined][] = [["title", doc.title]];
  doc.parties.forEach((p, i) => fields.push([`party ${i + 1} role`, p.role], [`party ${i + 1} name`, p.name]));
  doc.clauses.forEach((c, i) => fields.push([`clause ${i + 1} number`, c.number], [`clause ${i + 1} heading`, c.heading], [`clause ${i + 1} text`, c.text]));
  for (const [where, s] of fields) {
    if (typeof s !== "string") continue;
    const bad = unprintableChars(s);
    if (bad.length) return `${where}: cannot print ${show(bad)}`;
  }
  return null;
}
