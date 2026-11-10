// The model path stays live: rewordings that keep every template word (up to the allowed swaps, filler words,
// punctuation and spacing) are accepted as source "model". Synthetic data only; the model is a scripted stub.
import { describe, expect, it } from "vitest";
import { generateAgreement } from "@/lib/m23/m23-generate";
import type { GenerateInput, ModelProvider } from "@/lib/m23/m23-generate";

const services: GenerateInput = {
  kind: "services",
  parties: [{ role: "Provider", name: "Acme Design Studio" }, { role: "Client", name: "Example Widgets Ltd" }],
  terms: { fee: "$5,000", paymentDays: 30, startDate: "2027-03-01", noticeDays: 14, governingLaw: "Example State", lateFeePercent: 1.5, lateFeePeriod: "month" },
};
const nda: GenerateInput = {
  kind: "nda",
  parties: [{ role: "Disclosing Party", name: "Sample Labs" }, { role: "Receiving Party", name: "Test Partners" }],
  terms: { startDate: "2027-01-15", confidentialityYears: 3, governingLaw: "Example State" },
};
const lease: GenerateInput = {
  kind: "lease",
  parties: [{ role: "Landlord", name: "Jane Example" }, { role: "Tenant", name: "Sam Sample" }],
  terms: { propertyAddress: "1 Example Street, Testville", premisesUse: "residential use only", rentSchedule: "monthly, in advance, on the first day", subletting: "with written consent", rent: "$1,200", deposit: "$1,200", startDate: "2027-02-01", endDate: "2028-01-31", noticeDays: 60, governingLaw: "Example State" },
};
type C = { id: string; text: string };
const stub = (edit: (cs: C[]) => C[]): ModelProvider => ({ name: "scripted", complete: async (req) => ({ clauses: edit(JSON.parse(req.prompt).clauses) }) });
const subs = (pairs: [string, string | RegExp, string][]) => (cs: C[]) => cs.map((c) => pairs.reduce((acc, [id, from, to]) => (acc.id === id ? { ...acc, text: acc.text.replace(from, to) } : acc), { id: c.id, text: c.text }));
async function accepted(input: GenerateInput, edit: (cs: C[]) => C[]) {
  const r = await generateAgreement(input, { provider: stub(edit) });
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  expect(r.fallbackReasons).toEqual([]);
  expect(r.source).toBe("model");
  return r;
}

describe("legitimate rewordings are accepted (model path is not dead)", () => {
  it("identity output for every kind", async () => {
    for (const input of [services, nda, lease]) await accepted(input, (cs) => cs);
  });
  it("the allowed phrase swaps", async () => {
    const r = await accepted(services, subs([
      ["services", "will perform", "will carry out"],
      ["term", "starts on", "begins on"],
      ["termination", "already performed", "already carried out"],
    ]));
    expect(r.draft.clauses.find((c) => c.id === "services")!.text).toContain("carry out");
    await accepted(nda, subs([["return", "On request", "When asked"], ["term", "starts on", "commences on"]]));
    await accepted(lease, subs([["term", "starts on", "begins on"]]));
  });
  it("spacing and typographic quotes", async () => {
    await accepted(services, subs([
      ["termination", "days' written", "days\u2019 written"],
      ["parties", /"Provider"/, "\u201cProvider\u201d"],
      ["confidentiality", "Each party", "Each\u00a0party"],
    ]));
    await accepted(nda, subs([["parties", /"Disclosing Party"/, "\u201cDisclosing Party\u201d"], ["obligations", "only to evaluate", "only  to evaluate"]]));
    await accepted(lease, subs([["deposit", "after the lease", "after  the lease"]]));
  });
  it("a reword of several clauses at once", async () => {
    await accepted(services, subs([
      ["services", "will perform", "will carry out"],
      ["term", "starts", "begins"],
      ["termination", "Fees for services already performed", "Fees for services already carried out"],
    ]));
  });
});

describe("legitimate inputs are still accepted next to the S1 red-team defences", () => {
  it("plain tone notes still reach the model", async () => {
    let notes = "";
    const p: ModelProvider = { name: "spy", complete: async (req) => { notes = JSON.parse(req.prompt).userNotes; return { clauses: JSON.parse(req.prompt).clauses }; } };
    await generateAgreement({ ...services, instructions: "Plain, friendly tone \u2014 short sentences, Caf\u00e9 style." }, { provider: p });
    expect(notes).toBe("Plain, friendly tone \u2014 short sentences, Caf\u00e9 style.");
    for (const text of ["Keep it short\u2026 and friendly", "Plain\u00a0English please", "Use \u201cwe\u201d and \u2018you\u2019", "Rewrite the clauses in plain English", "Please remove legal jargon from the wording", "Note for the user: keep it short", "Fees are in \u00a3, keep that tone"]) {
      await generateAgreement({ ...services, instructions: text }, { provider: p });
      expect(notes, text).toBe(text);
    }
  });
  it("ordinary jurisdictions and addresses", async () => {
    const status = async (input: GenerateInput, terms: Record<string, string>) => (await generateAgreement({ ...input, terms: { ...input.terms, ...terms } })).status;
    for (const governingLaw of ["Delaware", "New York", "England and Wales", "the State of New York", "Washington, D.C.", "the Province of Ontario", "Saint Vincent and the Grenadines", "Free State"]) {
      expect(await status(services, { governingLaw }), governingLaw).toBe("ok");
    }
    for (const propertyAddress of ["1 Example Street, Testville", "Apt. 4B, 12 Sample Ave., Testville", "Flat 2, Rose Cottage, Little Testing", "No. 5 Sample Road, Testville", "12 May Street, Testville", "c/o Sample Holdings, 3 Test Lane", "No 5 Sample Road", "Flat 2, 4th floor, 10 High St", "12 Oak Cir., Testville", "Flat 3, Rose Court, Testville", "4 Bear Lane", "The Forum, 1 Main Street", "2 Free Lane", "Welcome Cottage, 2 Mill Lane", "Owner Lane 5"]) {
      expect(await status(lease, { propertyAddress }), propertyAddress).toBe("ok");
    }
  });
  it("distinct party names in printable accented Latin (names the PDF cannot print are refused, see test/redteam-s1)", async () => {
    const status = async (a: string, b: string) => (await generateAgreement({ ...services, parties: [{ role: "Provider", name: a }, { role: "Client", name: b }] })).status;
    expect(await status("M\u00fcller Testing GmbH", "Soci\u00e9t\u00e9 Exemple")).toBe("ok");
    expect(await status("Acme Ltd", "Acme Holdings Ltd")).toBe("ok");
    for (const [a, b] of [["Tilt Ltd", "Acme Ltd"], ["Tim Endicott", "Kim Ender"], ["Jim Starter", "M\u00f8ller Testing"]]) expect(await status(a, b), `${a} / ${b}`).toBe("ok");
  });
});
