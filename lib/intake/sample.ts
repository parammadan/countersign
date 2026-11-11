// "Try a sample agreement" on Document Intelligence: a SYNTHETIC consulting agreement (fictional parties, example.com
// addresses), always labelled as such. It is read and analyzed by exactly the same path as a pasted document: no
// stored or canned result. Plain module (no server imports), so the client form can use it.
export const SAMPLE_TITLE = "Sample (synthetic) agreement";

export const SAMPLE_AGREEMENT = [
  `SAMPLE (SYNTHETIC) AGREEMENT: fictional parties, for demonstration only

CONSULTING AGREEMENT

This Consulting Agreement is entered into by and between Northwind Advisory LLC, a Delaware limited liability company ("Consultant"), and Example Widgets Inc. ("Client").

Effective Date: January 15, 2027

1. Services. Consultant will provide the operations review described in Schedule A (the "Services") as an independent contractor.

2. Fees. Client will pay Consultant a fixed fee of $12,000 for the Services.

3. Payment. Consultant will invoice Client on completion. Client will pay each invoice within 30 days of receipt. Late payments accrue interest at 1.5% per month.

4. Term and Termination. This Agreement starts on the Effective Date and continues until the Services are complete. Either party may terminate this Agreement on 30 days' written notice to the other party. Fees for Services already performed remain payable.

5. Confidentiality. Each party will keep the other party's confidential information confidential for 3 years after this Agreement ends.`,
  `6. Intellectual Property. Each party keeps the intellectual property it owned before this Agreement. Work product that Consultant creates in performing the Services belongs to Client.

7. Non-Solicitation. During the term and for 12 months after it, neither party will solicit the other party's employees.

8. Limitation of Liability. Each party's total liability under this Agreement is limited to the fees paid under it.

9. Governing Law. This Agreement is governed by the laws of the State of Delaware.

10. Notices. Notices go to ops@northwind.example.com for Consultant and legal@widgets.example.com for Client.

Consultant Signature: ____________________
Name: Avery Tester, Managing Member

Client Signature: ____________________
Name: Jordan Sample, Chief Operating Officer`,
].join("\f");
