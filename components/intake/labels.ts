export const DECISION_LABEL = { ready_to_prepare: "Ready to prepare", needs_review: "Needs review", unsupported: "Unsupported" } as const;
export const DECISION_TONE = { ready_to_prepare: "ok", needs_review: "warn", unsupported: "neutral" } as const;
export const TYPE_LABEL: Record<string, string> = { services: "Services agreement", nda: "Non-disclosure agreement", lease: "Lease", order_form: "Order form", invoice: "Invoice", other: "Other document" };
// the Agreement Studio form's labels, for the same fields (one shared table)
export { TERM_LABEL } from "@/lib/drafts/labels";
