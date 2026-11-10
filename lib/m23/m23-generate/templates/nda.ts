import type { AgreementTemplate } from "../types";

export const nda: AgreementTemplate = {
  kind: "nda",
  title: "Non-Disclosure Agreement",
  roles: ["Disclosing Party", "Receiving Party"],
  requiredTerms: ["startDate", "confidentialityYears", "governingLaw"],
  clauses: [
    { id: "parties", heading: "Parties", required: true, text: "This Non-Disclosure Agreement is made between {{role:Disclosing Party}} (the \"Disclosing Party\") and {{role:Receiving Party}} (the \"Receiving Party\")." },
    { id: "definition", heading: "Confidential Information", required: true, text: "Confidential Information means non-public information the Disclosing Party shares with the Receiving Party, in any form, that is marked confidential or would reasonably be understood to be confidential." },
    { id: "obligations", heading: "Obligations", required: true, text: "The Receiving Party will use Confidential Information only to evaluate or carry out the relationship between the parties, protect it with reasonable care, and not disclose it to anyone else without written consent." },
    { id: "exclusions", heading: "Exclusions", required: true, text: "These obligations do not apply to information that is public through no fault of the Receiving Party, was already known to it, or is independently developed." },
    { id: "term", heading: "Term", required: true, text: "This Agreement starts on {{term:startDate}}. The obligations in clause {{ref:obligations}} continue for {{term:confidentialityYears}} years from that date." },
    { id: "term_end", heading: "End Date", required: false, when: "endDate", text: "This Agreement ends on {{term:endDate}}. Clause {{ref:term}} still sets how long the obligations in clause {{ref:obligations}} continue." },
    { id: "notice", heading: "Early Termination", required: false, when: "noticeDays", text: "Either party may end the exchange of information by giving {{term:noticeDays}} days' written notice; clause {{ref:obligations}} still applies to information already shared." },
    { id: "return", heading: "Return of Information", required: true, text: "On request the Receiving Party will return or destroy Confidential Information." },
    { id: "governing_law", heading: "Governing Law", required: true, text: "This Agreement is governed by the laws of {{term:governingLaw}}." },
    { id: "signatures", heading: "Signatures", required: true, locked: true, text: "Signed by {{role:Disclosing Party}} (Disclosing Party) and {{role:Receiving Party}} (Receiving Party). Each signer confirms they are authorised to sign for the party named." },
  ],
};
