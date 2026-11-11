import type { AgreementTemplate } from "../types";
import * as C from "./clauses";

// A general agreement for situations no specific template covers (hybrid drafting only, behind HYBRID_DRAFTING):
// the reviewed core every agreement needs, titled from the person's own description. Everything specific to the
// situation is added as AI-proposed clauses, which must each be reviewed before the draft can be approved.
const roles: [string, string] = ["First Party", "Second Party"];
const doc = "Agreement";

export const general: AgreementTemplate = {
  kind: "general",
  title: "Agreement",
  titleTerm: "agreementTitle",
  roles,
  requiredTerms: ["agreementTitle", "startDate", "noticeDays", "governingLaw"],
  clauses: [
    { id: "parties", heading: "Parties", required: true, text: 'This {{term:agreementTitle}} is made between {{role:First Party}} (the "First Party") and {{role:Second Party}} (the "Second Party").' },
    {
      id: "scope", heading: "Scope", required: true,
      text: "The parties enter into this Agreement on the terms set out in the clauses below.",
      alt: { when: "services", text: "The parties agree to the following, on the terms set out in the clauses below:\n{{term:services}}" },
    },
    C.term(doc),
    C.termEnd(doc),
    C.confidentiality(doc),
    C.termination(doc, "Obligations that by their nature continue after this Agreement ends remain in force."),
    C.liability(doc),
    C.governingLaw(doc),
    C.signatures(roles),
  ],
};
