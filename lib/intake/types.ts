// The shared agreement types come from lib/m23/shared (owned by S1); this module adds the intake record types.
export type { Clause, DraftDocument, EditProposal, ModelProvider } from "../m23/shared/agreement-model";

// ---- intake input ----
export type IntakeInput = {
  /** Extracted text, one string per page (page 1 = index 0). */
  pages: string[];
  metadata?: { filename?: string; title?: string; sourceId?: string };
};

// ---- intake output ----
export type DocType = "services" | "nda" | "lease" | "order_form" | "invoice" | "other";
export type Source = { page: number; quote: string }; // page is 1-based; quote is a verbatim substring of that page
export type Sourced<T> = { value: T; source: Source };

export type Candidate = { type: Exclude<DocType, "other">; score: number; reasons: { text: string; source?: Source }[] };
export type DateKind = "effective" | "start" | "end" | "due" | "invoice_date" | "order_date" | "signed" | "mentioned";
export type PartyValue = { role?: string; name: string };
export type DateValue = { kind: DateKind; iso: string; raw: string };
export type AmountValue = { label: string; currency: "USD" | "EUR" | "GBP"; amount: number; raw: string };
export type SignatureValue = { label: string; style: "blank" | "conformed" };
export type Conflict = { field: string; values: Sourced<string>[] };
export type RoutingDecision = "needs_review" | "ready_to_prepare" | "unsupported";

export type IntakeRecord = {
  schema: 1;
  metadata: IntakeInput["metadata"] | null;
  pageCount: number;
  documentType: {
    type: DocType;
    /** "rules" unless an optional ModelProvider chose among ambiguous candidates. */
    decidedBy: "rules" | "model";
    ambiguous: boolean;
    candidates: Candidate[];
    reasons: { text: string; source?: Source }[];
  };
  parties: Sourced<PartyValue>[];
  dates: Sourced<DateValue>[];
  amounts: Sourced<AmountValue>[];
  governingLaw: Sourced<string>[];
  signatureBlocks: Sourced<SignatureValue>[];
  conflicts: Conflict[];
  /** Required fields for the detected type that were not found. Never filled in. */
  missing: string[];
  /** Lines quarantined as probable prompt injection: excluded from every extraction above. */
  injection: Source[];
  /** Input limits hit (truncated pages or lines); any warning forces needs_review. */
  warnings: string[];
  routing: { decision: RoutingDecision; reasons: string[] };
};
