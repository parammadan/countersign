export const DECISION_LABEL = { ready_to_prepare: "Ready to prepare", needs_review: "Needs review", unsupported: "Unsupported" } as const;
export const DECISION_TONE = { ready_to_prepare: "ok", needs_review: "warn", unsupported: "neutral" } as const;
export const TYPE_LABEL: Record<string, string> = { services: "Services agreement", nda: "Non-disclosure agreement", lease: "Lease", order_form: "Order form", invoice: "Invoice", other: "Other document" };
// the Agreement Studio form's labels (components/studio/NewAgreement.tsx), for the same fields
export const TERM_LABEL: Record<string, string> = {
  fee: "Fee (with currency, e.g. $5,000)", paymentDays: "Payment due (days after invoice)", startDate: "Start date", endDate: "End date",
  noticeDays: "Notice period (days)", governingLaw: "Governing law (state or country)", lateFeePercent: "Late fee (% of the overdue amount)",
  lateFeePeriod: "Late fee charged per", rent: "Rent (with currency)", deposit: "Deposit (with currency)", confidentialityYears: "Confidentiality lasts (years)",
  propertyAddress: "Property address", licensedMaterial: "Licensed material (its name)", territory: "Territory (one or more, separated by ;)",
  exclusivity: "Exclusivity", ipOwner: "Who owns the work product", licensedUse: "What the licence allows", licenceTransfer: "Sublicensing or transfer",
  feePeriod: "Retainer fee is charged per", rentSchedule: "Rent schedule", premisesUse: "Use of the premises", subletting: "Subletting",
};
