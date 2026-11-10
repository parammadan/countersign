// Document output engine: DraftDocument -> PDF / DOCX. Pure functions, deterministic output.
import { renderDocx } from "./docx";
import { renderPdf } from "./pdf";
import { validateDraft } from "./validate";
import type { DraftDocument } from "./types";

export type { DraftDocument, Clause } from "./types";
export { renderDocx, renderPdf, validateDraft };
export { DraftValidationError, LIMITS, charProblem } from "./validate";
export { pdfTextProblem, pdfCanPrint, unprintableChars, pdfEquivalents, PDF_EQUIVALENTS } from "./pdf-text";
export type { DraftErrorCode } from "./validate";

export async function renderDocument(doc: DraftDocument, format: "pdf" | "docx"): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  validateDraft(doc);
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agreement";
  if (format === "pdf") return { bytes: await renderPdf(doc), contentType: "application/pdf", filename: `${slug}.pdf` };
  return { bytes: renderDocx(doc), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: `${slug}.docx` };
}
