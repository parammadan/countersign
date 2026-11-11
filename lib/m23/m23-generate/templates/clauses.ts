// Reusable clause structures for the template families. Every figure, date, party, jurisdiction, duration, fee,
// scope reference, territory and licence choice is a {{term:...}} or {{role:...}} placeholder filled from validated
// input; nothing here supplies a value the user did not give. Optional clauses carry `when`, so they appear only when
// the user supplied that term. The wording mirrors the approved services template where the meaning is the same.
import type { TemplateClause } from "../types";

/** "This <Title> is made between <A> (the "A") and <B> (the "B")." */
export const parties = (title: string, [a, b]: [string, string]): TemplateClause => ({
  id: "parties", heading: "Parties", required: true,
  text: `This ${title} is made between {{role:${a}}} (the "${a}") and {{role:${b}}} (the "${b}").`,
});

/** Scope by reference to the client's own request: the template never invents the work. */
export const scope = (heading: string, provider: string, client: string, what: string, where: string): TemplateClause => ({
  id: "scope", heading, required: true,
  text: `The ${provider} will perform the ${what} described in the ${client}'s ${where}, with reasonable skill and care.`,
});

/** The scope as the user's own list of services, when they gave one (`services`): one (a), (b) line per item. */
export const listedScope = (provider: string, what: string): NonNullable<TemplateClause["alt"]> => ({
  when: "services",
  text: `The ${provider} will perform the following ${what}, with reasonable skill and care:\n{{term:services}}`,
});

/** Start date (required) and how it ends; `until` says what ends it besides termination. */
export const term = (doc: string, until?: string): TemplateClause => ({
  id: "term", heading: "Term", required: true,
  text: `This ${doc} starts on {{term:startDate}} and continues until ${until ? `${until} or ` : ""}it is ended under clause {{ref:termination}}.`,
});

/** Optional fixed end date, only when the user gave one. */
export const termEnd = (doc: string): TemplateClause => ({
  id: "term_end", heading: "End Date", required: false, when: "endDate",
  text: `Unless ended earlier, this ${doc} ends on {{term:endDate}}.`,
});

/** The fee (required): who pays whom, how much, for what. */
export const fee = (id: string, heading: string, payer: string, payee: string, label: string, forWhat?: string, basis = false): TemplateClause => ({
  id, heading, required: true,
  text: `The ${payer} will pay the ${payee} ${label} of {{term:fee}}${forWhat ? ` for the ${forWhat}` : ""}.`,
  ...(basis && forWhat && { variants: feeBasisVariants(payer, payee, forWhat) }),
});

/**
 * How the fee is charged, when the user chose it (feeBasis): "a one-time fixed fee of $X for the services" or "a fee
 * of $X per month for the services". Without feeBasis the clause keeps its plain wording and states no basis.
 */
export const feeBasisVariants = (payer: string, payee: string, forWhat: string): NonNullable<TemplateClause["variants"]> => {
  const periodic = `The ${payer} will pay the ${payee} a fee of {{term:fee}} {{term:feeBasis}} for the ${forWhat}.`;
  return {
    term: "feeBasis",
    texts: { fixed: `The ${payer} will pay the ${payee} {{term:feeBasis}} of {{term:fee}} for the ${forWhat}.`, month: periodic, quarter: periodic, year: periodic },
  };
};

/** Optional payment timing, only when the user gave paymentDays; without it the document states no due date. */
export const payment = (payee: string, payer: string): TemplateClause => ({
  id: "payment", heading: "Payment", required: false, when: "paymentDays",
  text: `The ${payee} will invoice the ${payer}, and the ${payer} will pay each invoice within {{term:paymentDays}} days of receiving it.`,
});

export const confidentiality = (doc: string): TemplateClause => ({
  id: "confidentiality", heading: "Confidentiality", required: true,
  text: `Each party will keep the other party's confidential information private and use it only for this ${doc}.`,
});

/** Termination on the user's notice period (required), with what survives. */
export const termination = (doc: string, survives: string): TemplateClause => ({
  id: "termination", heading: "Termination", required: true,
  text: `Either party may end this ${doc} by giving the other {{term:noticeDays}} days' written notice. ${survives}`,
});

export const liability = (doc: string): TemplateClause => ({
  id: "liability", heading: "Liability", required: true,
  text: `Neither party is liable for indirect or consequential loss arising from this ${doc}.`,
});

export const governingLaw = (doc: string): TemplateClause => ({
  id: "governing_law", heading: "Governing Law", required: true,
  text: `This ${doc} is governed by the laws of {{term:governingLaw}}.`,
});

/** Locked signature block: never sent to the model, byte-identical in every draft. */
export const signatures = ([a, b]: [string, string]): TemplateClause => ({
  id: "signatures", heading: "Signatures", required: true, locked: true,
  text: `Signed by {{role:${a}}} (${a}) and {{role:${b}}} (${b}). Each signer confirms they are authorised to sign for the party named.`,
});
