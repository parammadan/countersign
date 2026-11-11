// The one table of human names for Agreement Studio's terms, shared by the forms (components/studio/NewAgreement,
// components/intake/DraftFromIntake) and the server's messages (lib/drafts/service). Plain module: no server imports,
// so client components can use it. Nothing the user sees may show a raw term key (feePeriod, ipOwner, ...).
import type { TermKey } from "../m23/m23-generate/types";

type TermText = {
  /** the form field's label */
  label: string;
  /** a short name for lists and messages */
  name: string;
};

export const TERM_TEXT: Record<TermKey, TermText> = {
  fee: { label: "Fee (with currency, e.g. $5,000)", name: "Fee" },
  feeBasis: { label: "How the fee is charged", name: "How the fee is charged" },
  paymentDays: { label: "Payment due (days after invoice)", name: "Invoice payment timing" },
  startDate: { label: "Start date", name: "Start date" },
  endDate: { label: "End date", name: "End date" },
  noticeDays: { label: "Notice period (days)", name: "Notice period" },
  governingLaw: { label: "Governing law (state or country)", name: "Governing law" },
  lateFeePercent: { label: "Late fee (% of the overdue amount)", name: "Late fee" },
  lateFeePeriod: { label: "Late fee charged per", name: "How the late fee is charged" },
  rent: { label: "Rent (with currency)", name: "Rent" },
  deposit: { label: "Deposit (with currency)", name: "Deposit" },
  confidentialityYears: { label: "Confidentiality lasts (years)", name: "How long confidentiality lasts" },
  propertyAddress: { label: "Property address", name: "Property address" },
  licensedMaterial: { label: "Licensed material (its name)", name: "Licensed material" },
  territory: { label: "Territory (one or more, separated by ;)", name: "Territory" },
  exclusivity: { label: "Exclusivity", name: "Exclusivity" },
  ipOwner: { label: "Who owns the work product", name: "Who owns the work product" },
  services: { label: "Services and deliverables (one per line)", name: "Services and deliverables" },
  licensedUse: { label: "What the licence allows", name: "What the licence allows" },
  licenceTransfer: { label: "Sublicensing or transfer", name: "Sublicensing or transfer" },
  feePeriod: { label: "Retainer fee is charged per", name: "How often the retainer fee is charged" },
  rentSchedule: { label: "Rent schedule", name: "Rent schedule" },
  premisesUse: { label: "Use of the premises", name: "Use of the premises" },
  subletting: { label: "Subletting", name: "Subletting" },
};

export const TERM_LABEL: Record<string, string> = Object.fromEntries(Object.entries(TERM_TEXT).map(([k, t]) => [k, t.label]));

const isTerm = (k: string): k is TermKey => Object.hasOwn(TERM_TEXT, k);
/** A term's short human name ("Notice period"); anything that isn't a term key comes back as "Other". */
export const termName = (k: string): string => (isTerm(k) ? TERM_TEXT[k].name : "Other");

/** Term keys that look like code (camelCase), longest first: what must never reach the screen. */
export const RAW_TERM_KEYS = (Object.keys(TERM_TEXT) as TermKey[]).filter((k) => /[A-Z]/.test(k)).sort((a, b) => b.length - a.length);
const RAW_RE = new RegExp(`\\b(?:term:)?(${RAW_TERM_KEYS.join("|")})\\b`, "g");

/** Replaces raw term keys ("feePeriod", "term:ipOwner") in a message with their human names. */
export const withTermNames = (s: string): string => s.replace(RAW_RE, (_m, k: TermKey) => TERM_TEXT[k].name);

/**
 * A generator issue ("missing: term:fee", "noticeDays: expected a whole number ...", "missing: party:Client") in
 * plain words, for showing to the person who filled the form.
 */
export function humanIssue(issue: string): string {
  const missing = /^missing: (term|party):(.+)$/.exec(issue);
  if (missing) return missing[1] === "term" ? `Missing: ${termName(missing[2])}` : `Missing: the ${missing[2]}'s legal name`;
  const party = /^party:([^:]+): (.+)$/.exec(issue);
  if (party) return withTermNames(`${party[1]}: ${party[2]}`);
  const field = /^([^:\s]+): (.+)$/.exec(issue);
  if (field && isTerm(field[1])) return withTermNames(`${TERM_TEXT[field[1]].name}: ${field[2]}`);
  return withTermNames(issue);
}
