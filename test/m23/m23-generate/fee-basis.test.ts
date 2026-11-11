// How the fee is charged (feeBasis): optional for consulting, services and engagement letters. Without it the fee
// clause keeps its plain wording; with it the clause says one-time fixed or per period. The retainer stays periodic
// (feePeriod), and no other template takes feeBasis. Synthetic data only; the model is a scripted stub.
import { describe, expect, it } from "vitest";
import { generateAgreement, TEMPLATES } from "@/lib/m23/m23-generate";
import type { GenerateInput, ModelProvider } from "@/lib/m23/m23-generate";
import { CHOICES } from "@/lib/m23/m23-generate/terms";

const base = { startDate: "2027-03-01", noticeDays: 21, governingLaw: "Example State", fee: "$12,000" } as const;
const INPUT: Record<"consulting" | "services" | "engagement", GenerateInput> = {
  consulting: { kind: "consulting", parties: [{ role: "Consultant", name: "Quartz Sample GmbH" }, { role: "Client", name: "Riley Testcase" }], terms: { ...base, ipOwner: "Client" } },
  services: { kind: "services", parties: [{ role: "Provider", name: "Acme Design Studio" }, { role: "Client", name: "Example Widgets Ltd" }], terms: { ...base, paymentDays: 30 } },
  engagement: { kind: "engagement", parties: [{ role: "Firm", name: "Bluefield Example Ltd" }, { role: "Client", name: "Jordan Placeholder" }], terms: { ...base } },
};
const PAYEE = { consulting: ["Consultant", "services"], services: ["Provider", "services"], engagement: ["Firm", "work"] } as const;
const feeClause = async (input: GenerateInput, provider?: ModelProvider) => {
  const r = await generateAgreement(input, provider ? { provider } : {});
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return { r, text: r.draft.clauses.find((c) => c.id === "fees")!.text };
};
type C = { id: string; text: string };
const stub = (edit: (cs: C[]) => C[]): ModelProvider => ({ name: "scripted", complete: async (req) => ({ clauses: edit(JSON.parse(req.prompt).clauses) }) });

describe("feeBasis: the fee clause says exactly how the fee is charged, or nothing about it", () => {
  for (const kind of ["consulting", "services", "engagement"] as const) {
    const [payee, what] = PAYEE[kind];
    it(`${kind}: absent = the current wording; fixed = one-time fixed fee; periodic = per period`, async () => {
      expect((await feeClause(INPUT[kind])).text).toBe(`The Client will pay the ${payee} a fee of $12,000 for the ${what}.`);
      const fixed = await feeClause({ ...INPUT[kind], terms: { ...INPUT[kind].terms, feeBasis: "fixed" } });
      expect(fixed.text).toBe(`The Client will pay the ${payee} a one-time fixed fee of $12,000 for the ${what}.`);
      for (const [basis, unit] of [["month", "per month"], ["quarter", "per quarter"], ["year", "per year"]]) {
        expect((await feeClause({ ...INPUT[kind], terms: { ...INPUT[kind].terms, feeBasis: basis } })).text).toBe(`The Client will pay the ${payee} a fee of $12,000 ${unit} for the ${what}.`);
      }
    });
    it(`${kind}: nothing but the fee clause changes`, async () => {
      const plain = (await feeClause(INPUT[kind])).r.draft.clauses;
      const fixed = (await feeClause({ ...INPUT[kind], terms: { ...INPUT[kind].terms, feeBasis: "fixed" } })).r.draft.clauses;
      expect(fixed.map((c) => c.id)).toEqual(plain.map((c) => c.id));
      expect(fixed.filter((c) => c.id !== "fees")).toEqual(plain.filter((c) => c.id !== "fees"));
    });
    it(`${kind}: a value that isn't one of the choices is refused`, async () => {
      for (const feeBasis of ["one-time", "Fixed", "per month", "week", "hour"]) {
        expect((await generateAgreement({ ...INPUT[kind], terms: { ...INPUT[kind].terms, feeBasis } })).status, feeBasis).toBe("invalid");
      }
    });
  }

  it("every choice has a wording, and only consulting, services and engagement offer it", () => {
    expect(Object.keys(CHOICES.feeBasis!).sort()).toEqual(["fixed", "month", "quarter", "year"]);
    const withBasis = Object.values(TEMPLATES).filter((t) => t.clauses.some((c) => c.variants?.term === "feeBasis")).map((t) => t.kind).sort();
    expect(withBasis).toEqual(["consulting", "engagement", "services"]);
    for (const t of Object.values(TEMPLATES)) for (const c of t.clauses.filter((x) => x.variants)) {
      expect(Object.keys(c.variants!.texts).sort(), `${t.kind}/${c.id}`).toEqual(Object.keys(CHOICES[c.variants!.term]!).sort());
      for (const text of Object.values(c.variants!.texts)) {
        // the same placeholders as the plain wording, plus the variant's own term; no hard-coded figure
        const terms = [...text.matchAll(/\{\{term:([^}]+)\}\}/g)].map((m) => m[1]);
        expect(terms.every((k) => k === c.variants!.term || t.requiredTerms.includes(k as never)), text).toBe(true);
        expect(text.replace(/\{\{[^}]+\}\}/g, "")).not.toMatch(/\d|[$€£%]/);
      }
    }
  });

  it("the retainer stays periodic and other templates refuse feeBasis (never dropped)", async () => {
    const retainer: GenerateInput = { kind: "retainer", parties: [{ role: "Firm", name: "Northwind Test LLP" }, { role: "Client", name: "Alex Sample" }], terms: { ...base, feePeriod: "month", feeBasis: "fixed" } };
    const licence: GenerateInput = {
      kind: "licence", parties: [{ role: "Licensor", name: "Cedar Mock Inc" }, { role: "Licensee", name: "Sam Fictional" }],
      terms: { ...base, licensedMaterial: "the Sample Analytics software", territory: "the United Kingdom", exclusivity: "non-exclusive", licensedUse: "use", licenceTransfer: "with written consent", feeBasis: "fixed" },
    };
    for (const input of [retainer, licence]) {
      const r = await generateAgreement(input);
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.issues.join()).toContain(`feeBasis: not supported by a ${input.kind} agreement`);
    }
    expect((await generateAgreement({ ...retainer, terms: { ...retainer.terms, feePeriod: "one-time", feeBasis: undefined } })).status).toBe("invalid");
  });

  it("the AI reword check uses the chosen wording as its baseline", async () => {
    const fixed = { ...INPUT.consulting, terms: { ...INPUT.consulting.terms, feeBasis: "fixed" } };
    // an allowed change elsewhere passes, and the fee clause stays the fixed-fee wording
    const ok = await feeClause(fixed, stub((cs) => cs.map((c) => (c.id === "term" ? { ...c, text: c.text.replace("starts on", "begins on") } : c))));
    expect(ok.r.source).toBe("model");
    expect(ok.text).toBe("The Client will pay the Consultant a one-time fixed fee of $12,000 for the services.");
    // dropping "one-time fixed" (back to the plain wording) is a meaning change: the whole reword is discarded
    const drop = await feeClause(fixed, stub((cs) => cs.map((c) => (c.id === "fees" ? { ...c, text: c.text.replace("a one-time fixed fee", "a fee") } : c))));
    expect(drop.r.source).toBe("template");
    expect(drop.text).toBe("The Client will pay the Consultant a one-time fixed fee of $12,000 for the services.");
    // and the plain wording can't gain a basis the user didn't choose
    const add = await feeClause(INPUT.consulting, stub((cs) => cs.map((c) => (c.id === "fees" ? { ...c, text: c.text.replace("a fee", "a one-time fixed fee") } : c))));
    expect(add.r.source).toBe("template");
    expect(add.text).toBe("The Client will pay the Consultant a fee of $12,000 for the services.");
    const monthly = { ...INPUT.consulting, terms: { ...INPUT.consulting.terms, feeBasis: "month" } };
    const unit = await feeClause(monthly, stub((cs) => cs.map((c) => (c.id === "fees" ? { ...c, text: c.text.replace("per month", "per year") } : c))));
    expect(unit.r.source).toBe("template");
  });
});
