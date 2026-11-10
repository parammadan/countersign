import type { AgreementTemplate } from "../types";

export const lease: AgreementTemplate = {
  kind: "lease",
  title: "Residential Lease Agreement",
  roles: ["Landlord", "Tenant"],
  // Rent timing, permitted use and subletting are the user's choices (no defaults; needs_input when missing).
  requiredTerms: ["propertyAddress", "premisesUse", "rent", "rentSchedule", "deposit", "subletting", "startDate", "endDate", "noticeDays", "governingLaw"],
  clauses: [
    { id: "parties", heading: "Parties", required: true, text: "This Lease Agreement is made between {{role:Landlord}} (the \"Landlord\") and {{role:Tenant}} (the \"Tenant\")." },
    { id: "premises", heading: "Premises", required: true, text: "The Landlord leases to the Tenant the property at {{term:propertyAddress}} (the \"Premises\") for {{term:premisesUse}}." },
    { id: "term", heading: "Term", required: true, text: "The lease starts on {{term:startDate}} and ends on {{term:endDate}}." },
    { id: "rent", heading: "Rent", required: true, text: "The Tenant will pay rent of {{term:rent}} {{term:rentSchedule}}." },
    { id: "late_fee", heading: "Late Rent", required: false, when: "lateFeePercent", text: "Rent that is late carries a late fee of {{term:lateFeePercent}} of the amount overdue." },
    { id: "deposit", heading: "Security Deposit", required: true, text: "The Tenant will pay a security deposit of {{term:deposit}}. The Landlord will return it after the lease ends, less any lawful deductions for damage or unpaid rent." },
    { id: "use", heading: "Care of the Premises", required: true, text: "The Tenant will keep the Premises clean, report damage promptly, and {{term:subletting}}." },
    { id: "termination", heading: "Ending the Lease", required: true, text: "Either party must give {{term:noticeDays}} days' written notice before the end date if they do not intend to renew. Clause {{ref:term}} sets the end date." },
    { id: "governing_law", heading: "Governing Law", required: true, text: "This Lease is governed by the laws of {{term:governingLaw}}." },
    { id: "signatures", heading: "Signatures", required: true, locked: true, text: "Signed by {{role:Landlord}} (Landlord) and {{role:Tenant}} (Tenant). Each signer confirms they are authorised to sign for the party named." },
  ],
};
