import type { AgreementTemplate } from "../types";
import * as C from "./clauses";

const roles: [string, string] = ["Licensor", "Licensee"];
const doc = "Agreement";

export const licence: AgreementTemplate = {
  kind: "licence",
  title: "Licence Agreement",
  roles,
  // What is licensed, what the Licensee may do with it, where, whether exclusively, and whether it may be passed on are
  // the user's choices: no defaults (needs_input when missing).
  requiredTerms: ["licensedMaterial", "licensedUse", "territory", "exclusivity", "licenceTransfer", "fee", "startDate", "noticeDays", "governingLaw"],
  clauses: [
    C.parties("Licence Agreement", roles),
    { id: "grant", heading: "Licence Grant", required: true, text: "The Licensor grants the Licensee {{term:exclusivity}} licence {{term:licensedUse}} the material known as \"{{term:licensedMaterial}}\" in {{term:territory}} while this Agreement is in force." },
    C.term(doc),
    C.termEnd(doc),
    C.fee("fees", "Licence Fees", "Licensee", "Licensor", "a licence fee"),
    C.payment("Licensor", "Licensee"),
    { id: "restrictions", heading: "Restrictions", required: true, text: "The Licensee will not sublicense, assign or transfer the licence in clause {{ref:grant}} {{term:licenceTransfer}}." },
    C.confidentiality(doc),
    C.termination(doc, "The licence ends when this Agreement ends, and fees already due remain payable."),
    C.liability(doc),
    C.governingLaw(doc),
    C.signatures(roles),
  ],
};
