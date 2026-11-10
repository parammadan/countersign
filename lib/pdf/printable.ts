// What the signed PDF can print. The stamps and the certificate use pdf-lib's standard Helvetica/Courier, which
// only encode WinAnsi (Windows-1252). A signed contract must never show a different name than the one signed, so:
//   - every WinAnsi character (Latin-1 letters like é ü ß ñ, € £, curly quotes, dashes) prints exactly;
//   - a few typographic characters outside WinAnsi print as their WinAnsi equivalent, which reads the same
//     (PDF_EQUIVALENTS, shared with the document renderer so both agree);
//   - anything else (ř, Ł, ő, CJK, emoji...) is never altered or replaced: inputs refuse it with printProblem,
//     and stamping refuses it (stamp.ts) as a last line of defence.
// Pure, no server imports: the signing room uses it too (lib/sign-fields.ts).
import { cleanText } from "../m23/doc-output/validate";
import { pdfCanPrint, pdfEquivalents } from "../m23/doc-output/pdf-text";

/** The text the PDF prints for s, and the distinct characters it can't print exactly (empty when it can). */
export function printForPdf(s: string): { text: string; bad: string[] } {
  // NFC is canonically the same text ("e" + combining acute is é); zero-width characters are invisible either way;
  // a line break or tab in a one-line stamp reads as a space.
  const text = pdfEquivalents(cleanText(s.normalize("NFC"))).replace(/[\t\r\n]+/g, " ");
  const bad = [...new Set([...text].filter((ch) => !pdfCanPrint(ch)))];
  return { text, bad };
}

/** The characters as a person reads them: visible ones as themselves, anything else as its code point. */
export function showChars(chs: string[]): string {
  return chs.map((ch) => (/^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch) ? ch : `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)).join(", ");
}

/**
 * null when the PDF prints s exactly; otherwise the user-facing refusal, e.g.
 * `This name has a character the signed PDF can't print exactly (ř). Use the name as it should appear, with
 * letters from Western European alphabets.`
 */
export function printProblem(s: string | null | undefined, subject = "This name", noun = "name"): string | null {
  if (!s) return null;
  const { bad } = printForPdf(s);
  if (!bad.length) return null;
  const which = bad.length === 1 ? "a character" : "characters";
  return `${subject} has ${which} the signed PDF can't print exactly (${showChars(bad)}). Use the ${noun} as it should appear, with letters from Western European alphabets.`;
}
