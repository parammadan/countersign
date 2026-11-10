import type { AgreementTemplate } from "../types";
import * as C from "./clauses";

const roles: [string, string] = ["Firm", "Client"];
const doc = "Engagement Letter";

export const engagement: AgreementTemplate = {
  kind: "engagement",
  title: "Engagement Letter",
  roles,
  requiredTerms: ["fee", "startDate", "noticeDays", "governingLaw"],
  clauses: [
    C.parties("Engagement Letter", roles),
    C.scope("Scope of Engagement", "Firm", "Client", "work", "engagement request"),
    C.term(doc, "the work is complete"),
    C.termEnd(doc),
    C.fee("fees", "Fees", "Client", "Firm", "a fee", "work"),
    C.payment("Firm", "Client"),
    { id: "client_duties", heading: "Client Responsibilities", required: true, text: "The Client will give the Firm complete and accurate information and instructions in good time." },
    C.confidentiality(doc),
    C.termination(doc, "Fees for work already performed remain payable."),
    C.liability(doc),
    C.governingLaw(doc),
    C.signatures(roles),
  ],
};
