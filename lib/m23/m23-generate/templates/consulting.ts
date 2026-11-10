import type { AgreementTemplate } from "../types";
import * as C from "./clauses";

const roles: [string, string] = ["Consultant", "Client"];
const doc = "Agreement";

export const consulting: AgreementTemplate = {
  kind: "consulting",
  title: "Consulting Agreement",
  roles,
  // ipOwner has no default: who owns what the Consultant creates is the user's choice (needs_input when missing).
  requiredTerms: ["fee", "startDate", "noticeDays", "governingLaw", "ipOwner"],
  clauses: [
    C.parties("Consulting Agreement", roles),
    C.scope("Scope of Services", "Consultant", "Client", "consulting services", "engagement request"),
    C.term(doc, "the services are complete"),
    C.termEnd(doc),
    C.fee("fees", "Fees", "Client", "Consultant", "a fee", "services"),
    C.payment("Consultant", "Client"),
    { id: "ip", heading: "Intellectual Property", required: true, text: "Each party keeps the intellectual property it owned before this Agreement. Intellectual property that the Consultant creates in performing the services belongs to the {{term:ipOwner}}." },
    { id: "independent", heading: "Independent Contractor", required: true, text: "The Consultant is an independent contractor and not an employee, partner or agent of the Client." },
    C.confidentiality(doc),
    C.termination(doc, "Fees for services already performed remain payable."),
    C.liability(doc),
    C.governingLaw(doc),
    C.signatures(roles),
  ],
};
