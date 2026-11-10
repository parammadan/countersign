import type { DraftDocument } from "@/lib/m23/doc-output";

const LONG = Array.from({ length: 260 }, (_, i) => `word${i}`).join(" ") + ".";
export const base: DraftDocument = {
  schema: 1,
  title: "Services Agreement",
  parties: [
    { role: "Firm", name: "Example Firm LLP" },
    { role: "Client", name: "Alex Example" },
  ],
  clauses: [
    { id: "c1", heading: "Scope", text: "The Firm will provide the services described in the engagement." },
    { id: "c2", number: "2.1", heading: "Fees", text: "Fees are billed monthly.\nPayment is due in 30 days & no later. <ok>" },
    { id: "c3", heading: "Term", text: LONG, locked: true },
    { id: "c4", text: "Governing law is the law of Exampleland." },
  ],
  origin: { kind: "generated" },
};
// Mixed text: unencodable characters, tabs, CR/CRLF, repeated and WinAnsi-only characters.
export const mixed: DraftDocument = {
  ...base,
  title: "Mixed 中 Title",
  clauses: [
    { id: "m1", heading: "Café – “quoted”", text: "Price 5 中 文 \u{1F600}\tTabbed\r\nNext line\rThird €100 • bullet" },
    { id: "m2", text: "plain text only", locked: true }, // locked is not rendered: output is unchanged by it
  ],
};
// Not signable, so refused (D3): see harden.test.ts.
export const noParties: DraftDocument = { ...base, parties: [] };
export const noClauses: DraftDocument = { ...base, clauses: [] };
export const empty: DraftDocument = { ...base, parties: [], clauses: [] };
export const noLocked: DraftDocument = { ...base, clauses: base.clauses.filter((c) => !c.locked) };
export const drafts: Record<string, DraftDocument> = { base, mixed };
