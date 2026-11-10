import type { AgreementTemplate } from "../types";
import * as C from "./clauses";

const roles: [string, string] = ["Firm", "Client"];
const doc = "Agreement";

export const retainer: AgreementTemplate = {
  kind: "retainer",
  title: "Retainer Agreement",
  roles,
  // The retainer is periodic: feePeriod has no default (needs_input), and a one-off retainer is not offered.
  requiredTerms: ["fee", "feePeriod", "startDate", "noticeDays", "governingLaw"],
  clauses: [
    C.parties("Retainer Agreement", roles),
    C.scope("Scope of Services", "Firm", "Client", "services", "engagement request"),
    C.term(doc),
    C.termEnd(doc),
    { id: "retainer", heading: "Retainer Fee", required: true, text: "The Client will pay the Firm a retainer fee of {{term:fee}} {{term:feePeriod}} for the services while this Agreement is in force." },
    C.payment("Firm", "Client"),
    C.confidentiality(doc),
    C.termination(doc, "Fees for services already performed remain payable."),
    C.liability(doc),
    C.governingLaw(doc),
    C.signatures(roles),
  ],
};
