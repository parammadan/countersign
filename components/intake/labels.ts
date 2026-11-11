import { TERM_LABEL, termName } from "@/lib/drafts/labels";

export const DECISION_LABEL = { ready_to_prepare: "Ready to prepare", needs_review: "Needs review", unsupported: "Unsupported" } as const;
export const DECISION_TONE = { ready_to_prepare: "ok", needs_review: "warn", unsupported: "neutral" } as const;
export const TYPE_LABEL: Record<string, string> = { services: "Services agreement", nda: "Non-disclosure agreement", lease: "Lease", order_form: "Order form", invoice: "Invoice", other: "Other document" };
// the Agreement Studio form's labels, for the same fields (one shared table)
export { TERM_LABEL } from "@/lib/drafts/labels";

// The rules' field names ("dates.effective_or_start", "amounts.fee", "parties.Provider") in plain words, for people.
const FIELD_TEXT: Record<string, string> = {
  "parties (need two)": "the two parties",
  parties: "the parties",
  governingLaw: "governing law",
  signatureBlocks: "signature blocks",
  "dates.effective_or_start": "the effective or start date",
  "amounts.rent": "the rent",
  "amounts.total_or_fee": "the total or fee",
};
const DATE_TEXT: Record<string, string> = { effective: "effective date", start: "start date", end: "end date", due: "due date", invoice_date: "invoice date", order_date: "order date" };
/** A rules field name in plain words. */
export function fieldText(f: string): string {
  if (Object.hasOwn(FIELD_TEXT, f)) return FIELD_TEXT[f];
  const [group, rest] = [f.slice(0, f.indexOf(".")), f.slice(f.indexOf(".") + 1)];
  if (group === "parties") return `the ${rest}'s name`;
  if (group === "dates") return `the ${DATE_TEXT[rest] ?? rest.replace(/_/g, " ")}`;
  if (group === "amounts") return rest === "unlabelled" ? "an unlabelled amount" : `the ${rest.replace(/_/g, " ")}`;
  return f.replace(/_/g, " ");
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A routing reason from the rules ("missing dates.effective_or_start") as a sentence a person can act on. */
export function reasonText(r: string): string {
  const missing = /^missing (.+)$/.exec(r);
  if (missing) return `Missing ${fieldText(missing[1])}`;
  const conflict = /^conflicting values for (.+)$/.exec(r);
  if (conflict) return `Conflicting values for ${fieldText(conflict[1])}`;
  return cap(r);
}
/** A date's kind as a row label ("effective" -> "Effective date"). */
export const dateKindLabel = (k: string) => cap(DATE_TEXT[k] ?? (k === "signed" ? "signing date" : k === "mentioned" ? "date mentioned" : k.replace(/_/g, " ")));

type AiValues = { names: Record<string, string>; terms: Partial<Record<string, string>>; sources: { key: string; value: string; page: number; quote: string }[] };
/** The values only Claude read (not the rules), each labelled with its form field and the quote it came from. */
export function aiOnlyValues(ai: AiValues | undefined): { key: string; label: string; value: string; source?: { page: number; quote: string } }[] {
  if (!ai) return [];
  return [
    ...Object.entries(ai.names).map(([role, value]) => ({ key: `role:${role}`, label: `${role} (legal name)`, value, source: ai.sources.find((x) => x.key.startsWith("role:") && x.value === value) })),
    ...Object.entries(ai.terms).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "").map(([key, value]) => ({ key: `term:${key}`, label: TERM_LABEL[key] ?? termName(key), value, source: ai.sources.find((x) => x.key === `term:${key}`) })),
  ];
}
