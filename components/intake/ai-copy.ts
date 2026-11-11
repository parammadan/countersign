// Document Intelligence's wording, in one place (plain module: the server pages and the client forms both use it).
// Fixed text only. It describes what the page really does: Claude reads ONE document and every point is checked
// against its text; it never claims legal advice or a custom-drafted agreement.
import type { DocAiReason } from "@/lib/intake/ai-service";

export const DOC_AI_COPY = {
  heading: "Understand any document with AI",
  intro: "Upload a document to understand its terms, ask questions, and prepare an agreement draft.",
  scope: "This page: one document. Knowledge Hub: questions across all your agreements.",
  drop: "Drop a PDF or Word file here, or",
  choose: "choose a file",
  fileHint: "PDF or Word, up to 1.9 MB. Scanned images without a text layer can't be read.",
  pasteLabel: "Or paste the text",
  pasteHint: "Separate pages with a form feed if you have them; up to 200,000 characters.",
  analyze: "Analyze with AI",
  rulesOnly: "Read the document",
  sample: "Try a sample agreement",
  sampleHint: "A synthetic consulting agreement with fictional parties, analyzed the same way as your own documents.",
  reading: "Reading the document…",
  analyzing: "Claude is analyzing the document and checking every point against its text. This can take up to a minute…",
  opening: "Opening the results…",
  disclaimer: "Informational, not legal advice",
  emptyTitle: "No documents yet",
  empty: "Upload or paste a document, or try the sample agreement.",
} as const;

/** Why a document isn't analyzed with AI (the rules' reading still runs). Reasons come from the server's state. */
export const DOC_AI_UNAVAILABLE: Record<DocAiReason, string> = {
  off: "AI isn't configured on this server, so documents are read by rules only: the type, parties, dates, amounts and governing law, each with its quote.",
  unverified: "Confirm your email address to use AI analysis. Until then, documents are read by rules only.",
  spend_cap: "The AI assistant has reached today's spending limit, so documents are read by rules only until it resets.",
  no_text: "This document was read before AI analysis was available. Read it again to analyze it with AI.",
  scan_incomplete: "This document couldn't be fully checked for hidden instructions aimed at an AI, so it isn't sent to AI.",
  empty: "This document has no text we can read (it may be a scanned image), so there is nothing to analyze or ask about. Upload a PDF with selectable text, or paste the text.",
  all_quarantined: "All of this document's text was set aside as possible instructions to an AI, so it can't be analysed.",
};

export const CHAT_EXAMPLES = [
  "Explain this agreement in simple English.",
  "Can either party terminate early?",
  "Who owns the work product?",
  "What happens if payment is late?",
] as const;
