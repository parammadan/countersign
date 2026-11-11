import type { DraftDocument, ModelProvider } from "../shared/agreement-model";

export type Kind = "services" | "nda" | "lease" | "retainer" | "engagement" | "consulting" | "licence" | "general";
export type TermKey =
  | "fee" | "paymentDays" | "startDate" | "endDate" | "noticeDays" | "governingLaw"
  | "lateFeePercent" | "rent" | "deposit" | "confidentialityYears" | "propertyAddress"
  | "licensedMaterial" | "territory" | "exclusivity" | "ipOwner" | "licensedUse" | "licenceTransfer" | "feePeriod"
  | "feeBasis" | "rentSchedule" | "premisesUse" | "subletting" | "lateFeePeriod" | "services" | "agreementTitle";

/**
 * money: "$5,000" / "USD 5,000.00" (a currency is required; bare numbers are rejected); date: YYYY-MM-DD; int;
 * percent: number 0-100; text: short free text; choice: one of a fixed list of values (see CHOICES in terms.ts);
 * territory: one or more names from the closed list in territories.ts, separated by ";"; list: the user's own short
 * items (services, deliverables), separated by ";" or new lines, rendered as (a), (b), (c) lines.
 */
export type TermType = "money" | "date" | "int" | "percent" | "text" | "choice" | "territory" | "list";

export type GenerateInput = {
  kind: Kind;
  parties: { role: string; name: string }[];
  terms: Partial<Record<TermKey, string | number>>;
  /** Wording/style hints for the optional model step only. Untrusted: never changes parties, terms or clauses. */
  instructions?: string;
};

export type TemplateClause = {
  id: string;
  heading: string;
  /** Placeholders: {{role:Provider}} party name, {{term:fee}} rendered term, {{ref:payment}} clause number. */
  text: string;
  required: boolean;
  locked?: boolean;
  /** Include this clause only when this term was supplied. */
  when?: TermKey;
  /**
   * Wording chosen by an optional choice term: `texts[value]` when the user gave that term, `text` (unchanged) when
   * they didn't. Every choice of the term must have a text (asserted in the template tests).
   */
  variants?: { term: TermKey; texts: Record<string, string> };
  /** Reviewed wording used instead of `text` when this (optional) term was supplied, e.g. a listed scope of services. */
  alt?: { when: TermKey; text: string };
};

export type AgreementTemplate = {
  kind: Kind;
  title: string;
  /** A text term whose value is the document's title instead of `title` (the general agreement: "Event Sponsorship Agreement"). */
  titleTerm?: TermKey;
  roles: [string, string];
  requiredTerms: TermKey[];
  clauses: TemplateClause[];
};

export type GenerateOptions = {
  provider?: ModelProvider;
  /** Deadline for the provider call in ms (default 30,000, at most 120,000). On timeout the template draft is returned. */
  timeoutMs?: number;
};
export type { ModelProvider };

export type GenerateResult =
  | { status: "invalid"; issues: string[] }
  | { status: "needs_input"; missing: string[]; issues: string[] }
  | {
      status: "ok";
      draft: DraftDocument;
      /** "template" when no provider was given or the model output was rejected. */
      source: "template" | "model";
      /** Why the model output was rejected (empty unless it fell back). */
      fallbackReasons: string[];
      /** Non-fatal notes, e.g. instruction-like text in the user instructions was ignored. */
      notes: string[];
      /** How many clauses the model's accepted wording changed (0 for "template"; 0 with "model" = nothing to reword). */
      reworded: number;
    };
