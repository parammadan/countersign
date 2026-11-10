import type { AgreementTemplate } from "../types";

export const services: AgreementTemplate = {
  kind: "services",
  title: "Services Agreement",
  roles: ["Provider", "Client"],
  requiredTerms: ["fee", "paymentDays", "startDate", "noticeDays", "governingLaw"],
  clauses: [
    { id: "parties", heading: "Parties", required: true, text: "This Services Agreement is made between {{role:Provider}} (the \"Provider\") and {{role:Client}} (the \"Client\")." },
    { id: "services", heading: "Scope of Services", required: true, text: "The Provider will perform the services described in the Client's engagement request, with reasonable skill and care." },
    { id: "term", heading: "Term", required: true, text: "This Agreement starts on {{term:startDate}} and continues until the services are complete or it is ended under clause {{ref:termination}}." },
    { id: "term_end", heading: "End Date", required: false, when: "endDate", text: "Unless ended earlier, this Agreement ends on {{term:endDate}}." },
    { id: "fees", heading: "Fees", required: true, text: "The Client will pay the Provider a fee of {{term:fee}} for the services." },
    { id: "payment", heading: "Payment", required: true, text: "The Provider will invoice the Client, and the Client will pay each invoice within {{term:paymentDays}} days of receiving it." },
    { id: "late_fee", heading: "Late Payment", required: false, when: "lateFeePercent", text: "Overdue amounts carry a late fee of {{term:lateFeePercent}} {{term:lateFeePeriod}}." },
    { id: "confidentiality", heading: "Confidentiality", required: true, text: "Each party will keep the other party's confidential information private and use it only for this Agreement." },
    { id: "termination", heading: "Termination", required: true, text: "Either party may end this Agreement by giving the other {{term:noticeDays}} days' written notice. Fees for services already performed remain payable." },
    { id: "liability", heading: "Liability", required: true, text: "Neither party is liable for indirect or consequential loss arising from this Agreement." },
    { id: "governing_law", heading: "Governing Law", required: true, text: "This Agreement is governed by the laws of {{term:governingLaw}}." },
    { id: "signatures", heading: "Signatures", required: true, locked: true, text: "Signed by {{role:Provider}} (Provider) and {{role:Client}} (Client). Each signer confirms they are authorised to sign for the party named." },
  ],
};
