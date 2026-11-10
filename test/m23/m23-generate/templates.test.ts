// Template families: retainer, engagement letter, consulting, licence (plus structural rules for every template).
// Every figure, date, party, jurisdiction, duration, fee, territory and licence choice must come from input;
// a missing required term is needs_input, never a default. Synthetic data only; the model is a scripted stub.
import { describe, expect, it } from "vitest";
import { generateAgreement, TEMPLATES } from "@/lib/m23/m23-generate";
import type { GenerateInput, ModelProvider, TermKey } from "@/lib/m23/m23-generate";
import * as C from "@/lib/m23/m23-generate/templates/clauses";
import { validateDraft } from "@/lib/m23/doc-output";

const base = { startDate: "2027-03-01", noticeDays: 21, governingLaw: "Example State", fee: "USD 4,800" } as const;
const FULL: Record<"retainer" | "engagement" | "consulting" | "licence", GenerateInput> = {
  retainer: { kind: "retainer", parties: [{ role: "Firm", name: "Northwind Test LLP" }, { role: "Client", name: "Alex Sample" }], terms: { ...base, feePeriod: "month" } },
  engagement: { kind: "engagement", parties: [{ role: "Firm", name: "Bluefield Example Ltd" }, { role: "Client", name: "Jordan Placeholder" }], terms: { ...base } },
  consulting: { kind: "consulting", parties: [{ role: "Consultant", name: "Quartz Sample GmbH" }, { role: "Client", name: "Riley Testcase" }], terms: { ...base, ipOwner: "Client" } },
  licence: {
    kind: "licence", parties: [{ role: "Licensor", name: "Cedar Mock Inc" }, { role: "Licensee", name: "Sam Fictional" }],
    terms: { ...base, licensedMaterial: "the Sample Analytics software", territory: "the United Kingdom", exclusivity: "non-exclusive", licensedUse: "use", licenceTransfer: "with written consent" },
  },
};
const NEW = Object.keys(FULL) as (keyof typeof FULL)[];
type C2 = { id: string; text: string };
const stub = (edit: (cs: C2[]) => C2[]): ModelProvider => ({ name: "scripted", complete: async (req) => ({ clauses: edit(JSON.parse(req.prompt).clauses) }) });
const ok = async (input: GenerateInput, provider?: ModelProvider) => {
  const r = await generateAgreement(input, provider ? { provider } : {});
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r;
};

describe("structural rules for every template", () => {
  for (const [kind, t] of Object.entries(TEMPLATES)) {
    it(`${kind}: locked signature clause last, placeholders resolvable, no hard-coded figure or date`, () => {
      const last = t.clauses.at(-1)!;
      expect(last).toMatchObject({ id: "signatures", locked: true, required: true });
      expect(t.clauses.filter((c) => c.locked).map((c) => c.id)).toEqual(["signatures"]);
      const ids = new Set(t.clauses.map((c) => c.id));
      expect(ids.size).toBe(t.clauses.length);
      for (const c of t.clauses) {
        for (const m of c.text.matchAll(/\{\{(role|term|ref):([^}]+)\}\}/g)) {
          if (m[1] === "role") expect(t.roles).toContain(m[2]);
          if (m[1] === "ref") expect(ids.has(m[2]), `${c.id} -> ${m[2]}`).toBe(true);
          if (m[1] === "term") expect(t.requiredTerms.includes(m[2] as TermKey) || c.when !== undefined, `${c.id}: ${m[2]}`).toBe(true);
        }
        const fixed = c.text.replace(/\{\{[^}]+\}\}/g, "");
        expect(fixed, `${kind}/${c.id}`).not.toMatch(/\d|[$€£%]|\b(January|February|March|April|June|July|August|September|October|November|December)\b/);
      }
    });
  }
  it("the shared clause builders reproduce the approved services wording exactly", () => {
    const s = Object.fromEntries(TEMPLATES.services.clauses.map((c) => [c.id, c.text]));
    expect(C.scope("Scope of Services", "Provider", "Client", "services", "engagement request").text).toBe(s.services);
    expect(C.term("Agreement", "the services are complete").text).toBe(s.term);
    expect(C.termEnd("Agreement").text).toBe(s.term_end);
    expect(C.fee("fees", "Fees", "Client", "Provider", "a fee", "services").text).toBe(s.fees);
    expect(C.payment("Provider", "Client").text).toBe(s.payment);
    expect(C.confidentiality("Agreement").text).toBe(s.confidentiality);
    expect(C.termination("Agreement", "Fees for services already performed remain payable.").text).toBe(s.termination);
    expect(C.liability("Agreement").text).toBe(s.liability);
    expect(C.governingLaw("Agreement").text).toBe(s.governing_law);
    expect(C.signatures(["Provider", "Client"]).text).toBe(s.signatures);
  });
});

describe("new template families: template-only drafts", () => {
  for (const kind of NEW) {
    it(`${kind}: complete draft from input only, valid for S13, every input value verbatim`, async () => {
      const input = FULL[kind];
      const r = await ok(input);
      expect(r.source).toBe("template");
      expect(r.draft.parties).toEqual(input.parties);
      r.draft.clauses.forEach((c, i) => expect(c.number).toBe(String(i + 1)));
      expect(r.draft.clauses.at(-1)).toMatchObject({ id: "signatures", locked: true });
      const all = r.draft.clauses.map((c) => c.text).join("\n");
      expect(all).not.toContain("{{");
      for (const p of input.parties) expect(all).toContain(p.name);
      for (const tc of TEMPLATES[kind].clauses.filter((c) => c.required)) expect(r.draft.clauses.some((c) => c.id === tc.id), tc.id).toBe(true);
      expect(all).toContain("USD 4,800");
      expect(all).toContain("March 1, 2027");
      expect(all).toContain("21 days' written notice");
      expect(all).toContain("the laws of Example State");
      // No figure the input did not give: every digit run is a rendered term or a clause number.
      const digits = all.replace(/USD 4,800|March 1, 2027|21 days|clause \d+/g, "").match(/\d+/g);
      expect(digits).toBeNull();
      expect(() => validateDraft(r.draft)).not.toThrow();
    });
    it(`${kind}: each required term missing gives needs_input for exactly that term (no default)`, async () => {
      for (const key of TEMPLATES[kind].requiredTerms) {
        const terms = { ...FULL[kind].terms };
        delete terms[key];
        const r = await generateAgreement({ ...FULL[kind], terms });
        expect(r, `${kind} without ${key}`).toMatchObject({ status: "needs_input", missing: [`term:${key}`] });
      }
    });
    it(`${kind}: payment timing and end date appear only when given`, async () => {
      const without = await ok(FULL[kind]);
      expect(without.draft.clauses.map((c) => c.id)).not.toContain("payment");
      expect(without.draft.clauses.map((c) => c.id)).not.toContain("term_end");
      const withBoth = await ok({ ...FULL[kind], terms: { ...FULL[kind].terms, paymentDays: 45, endDate: "2028-02-29" } });
      const text = withBoth.draft.clauses.map((c) => c.text).join("\n");
      expect(text).toContain("within 45 days of receiving it");
      expect(text).toContain("ends on February 29, 2028");
    });
  }
  it("licence: the grant and restrictions state exactly the user's exclusivity, permitted use, material, territory and licenceTransfer choice", async () => {
    const draft = async (terms: Record<string, string>) => (await ok({ ...FULL.licence, terms: { ...FULL.licence.terms, ...terms } })).draft;
    const clause = async (terms: Record<string, string>, id: string) => (await draft(terms)).clauses.find((c) => c.id === id)!.text;
    expect(await clause({}, "grant")).toBe('The Licensor grants the Licensee a non-exclusive licence to use the material known as "the Sample Analytics software" in the United Kingdom while this Agreement is in force.');
    expect(await clause({ exclusivity: "exclusive", licensedUse: "use, modify and distribute" }, "grant")).toBe('The Licensor grants the Licensee an exclusive licence to use, modify and distribute the material known as "the Sample Analytics software" in the United Kingdom while this Agreement is in force.');
    expect(await clause({ licensedUse: "use and modify" }, "grant")).toContain('licence to use and modify the material known as "the Sample');
    expect(await clause({}, "restrictions")).toBe("The Licensee will not sublicense, assign or transfer the licence in clause 2 without the Licensor's written consent.");
    expect(await clause({ licenceTransfer: "not permitted" }, "restrictions")).toBe("The Licensee will not sublicense, assign or transfer the licence in clause 2 in any circumstances.");
    // No ownership, royalty or other licence position the user did not choose.
    expect(JSON.stringify(await draft({}))).not.toMatch(/ownership|royalt|owns/i);
  });
  it("retainer: the fee period is the user's choice (no one-off retainer for open-ended services)", async () => {
    for (const [feePeriod, unit] of [["month", "per month"], ["quarter", "per quarter"], ["year", "per year"]]) {
      const r = await ok({ ...FULL.retainer, terms: { ...FULL.retainer.terms, feePeriod } });
      expect(r.draft.clauses.find((c) => c.id === "retainer")!.text).toBe(`The Client will pay the Firm a retainer fee of USD 4,800 ${unit} for the services while this Agreement is in force.`);
    }
    for (const feePeriod of ["one-off", "week", "per month", "Month"]) expect((await generateAgreement({ ...FULL.retainer, terms: { ...FULL.retainer.terms, feePeriod } })).status, feePeriod).toBe("invalid");
  });
  it("a term the template cannot state is refused, never dropped with a note", async () => {
    const cases: [keyof typeof FULL, Record<string, string | number>][] = [
      ["consulting", { confidentialityYears: 2 }], ["retainer", { exclusivity: "exclusive" }], ["retainer", { territory: "Canada" }],
      ["retainer", { lateFeePercent: 5 }], ["engagement", { ipOwner: "Client" }], ["licence", { feePeriod: "month" }], ["consulting", { licenceTransfer: "not permitted" }],
    ];
    for (const [kind, extra] of cases) {
      const r = await generateAgreement({ ...FULL[kind], terms: { ...FULL[kind].terms, ...extra } });
      expect(r.status, `${kind} + ${Object.keys(extra)[0]}`).toBe("invalid");
      if (r.status === "invalid") expect(r.issues.join()).toContain(`${Object.keys(extra)[0]}: not supported by a ${kind} agreement`);
    }
  });
  it("consulting: IP ownership is the user's choice", async () => {
    for (const ipOwner of ["Client", "Consultant"]) {
      const r = await ok({ ...FULL.consulting, terms: { ...FULL.consulting.terms, ipOwner } });
      expect(r.draft.clauses.find((c) => c.id === "ip")!.text).toMatch(new RegExp(`belongs to the ${ipOwner}\\.$`));
    }
  });
  it("choices outside the fixed list, and sentences in text terms, are invalid", async () => {
    const st = async (kind: keyof typeof FULL, terms: Record<string, string>) => (await generateAgreement({ ...FULL[kind], terms: { ...FULL[kind].terms, ...terms } })).status;
    for (const exclusivity of ["Exclusive", "sole", "exclusive worldwide", "", " "]) expect(await st("licence", { exclusivity }), exclusivity).not.toBe("ok");
    for (const licensedUse of ["use and sell", "any use", "Use", ""]) expect(await st("licence", { licensedUse }), licensedUse).not.toBe("ok");
    for (const licenceTransfer of ["permitted", "freely", "allowed", ""]) expect(await st("licence", { licenceTransfer }), licenceTransfer).not.toBe("ok");
    for (const ipOwner of ["Licensor", "client", "Both", "Consultant and Client"]) expect(await st("consulting", { ipOwner }), ipOwner).toBe("invalid");
    for (const territory of ["Worldwide. The Licensee may sublicense", "the United Kingdom, Royalty Free", "Region 5", "the Licensor's territory", "Worldwide", "Everywhere But France", "Any Country"]) expect(await st("licence", { territory }), territory).toBe("invalid");
    for (const licensedMaterial of ["the software. The Licensee waives all claims", "the software and the Licensee may sublicense it", "the Licensor's software", "all source code exclusively", "the software and to copy, modify and sell it", "the software for any purpose and to make derivative works", "the source code and resell copies of it"]) expect(await st("licence", { licensedMaterial }), licensedMaterial).toBe("invalid");
  });
  it("nda: confidentialityYears is required, and a user end date appears only when given", async () => {
    const nda: GenerateInput = { kind: "nda", parties: [{ role: "Disclosing Party", name: "Sample Labs" }, { role: "Receiving Party", name: "Test Partners" }], terms: { startDate: "2027-01-15", confidentialityYears: 2, governingLaw: "Example State" } };
    const { confidentialityYears: _y, ...noYears } = nda.terms;
    void _y;
    expect(await generateAgreement({ ...nda, terms: noYears })).toMatchObject({ status: "needs_input", missing: ["term:confidentialityYears"] });
    expect((await ok(nda)).draft.clauses.map((c) => c.id)).not.toContain("term_end");
    const r = await ok({ ...nda, terms: { ...nda.terms, endDate: "2027-12-31" } });
    expect(r.notes).toEqual([]);
    const end = r.draft.clauses.find((c) => c.id === "term_end")!;
    expect(end.text).toBe(`This Agreement ends on December 31, 2027. Clause ${r.draft.clauses.find((c) => c.id === "term")!.number} still sets how long the obligations in clause ${r.draft.clauses.find((c) => c.id === "obligations")!.number} continue.`);
    expect(r.draft.clauses.find((c) => c.id === "term")!.text).toContain("continue for 2 years from that date");
  });
  it("a role from another template is not accepted", async () => {
    const r = await generateAgreement({ ...FULL.retainer, parties: [{ role: "Provider", name: "Northwind Test LLP" }, { role: "Client", name: "Alex Sample" }] });
    expect(r.status).toBe("invalid");
  });
});

describe("new template families pass the meaning checks", () => {
  for (const kind of NEW) {
    it(`${kind}: an identity or allowed-swap reword is accepted as model`, async () => {
      const r = await ok(FULL[kind], stub((cs) => cs.map((c) => ({ id: c.id, text: c.text.replace("will perform", "will carry out").replace("starts on", "begins on") }))));
      expect(r.fallbackReasons).toEqual([]);
      expect(r.source).toBe("model");
      expect(() => validateDraft(r.draft)).not.toThrow();
    });
  }
  const refused: [keyof typeof FULL, string, string | RegExp, string][] = [
    ["retainer", "termination", " Fees for services already performed remain payable.", ""],
    ["retainer", "liability", "indirect or ", ""],
    ["engagement", "client_duties", "complete and accurate ", ""],
    ["engagement", "scope", "with reasonable skill and care", "with care"],
    ["consulting", "independent", "not an employee, partner or agent", "an employee, partner or agent"],
    ["consulting", "ip", "belongs to the Client", "belongs to the Consultant"],
    ["consulting", "ip", "Each party keeps the intellectual property it owned before this Agreement. ", ""],
    ["licence", "restrictions", " without the Licensor's written consent", ""],
    ["licence", "restrictions", "without the Licensor's written consent", "in any circumstances"],
    ["licence", "grant", "licence to use", "licence to use and modify"],
    ["retainer", "retainer", "per month", "per quarter"],
    ["retainer", "retainer", " while this Agreement is in force", ""],
    ["licence", "grant", "a non-exclusive", "an exclusive"],
    ["licence", "grant", "in the United Kingdom", "worldwide"],
    ["licence", "termination", "The licence ends when this Agreement ends, and fees", "Fees"],
  ];
  for (const [kind, id, from, to] of refused) {
    it(`${kind}/${id}: a reword that drops or changes restrictive or user-chosen wording falls back (${String(from).slice(0, 30)})`, async () => {
      const r = await ok(FULL[kind], stub((cs) => cs.map((c) => (c.id === id ? { id, text: c.text.replace(from, to) } : c))));
      expect(r.source).toBe("template");
      expect(r.fallbackReasons.join("\n")).toMatch(new RegExp(`^${id}: `, "m"));
      expect(r.draft).toEqual((await ok(FULL[kind])).draft);
    });
  }
});


describe("templates review round 2", () => {
  const st = async (kind: keyof typeof FULL, terms: Record<string, string>) => (await generateAgreement({ ...FULL[kind], terms: { ...FULL[kind].terms, ...terms } })).status;
  it("licensedMaterial cannot widen the grant past the chosen use (verbs, pronouns, places)", async () => {
    for (const licensedMaterial of ["the software and make derived works", "the software and publish it", "the software and adapt and translate it", "the software in France", "the software to sell", "the Software And Publish It", "the Software Worldwide"]) {
      expect(await st("licence", { licensedMaterial }), licensedMaterial).toBe("invalid");
    }
  });
  it("territory synonyms for the whole world are refused (worldwide is not offered as a free-text territory)", async () => {
    for (const territory of ["All Countries", "The Whole World", "Earth", "Anywhere", "Elsewhere", "Unrestricted", "Each Country"]) expect(await st("licence", { territory }), territory).toBe("invalid");
  });
  it("ordinary names are not caught by the licence-scope words", async () => {
    for (const licensedMaterial of ["the Copyright Works catalogue", "the Seller Portal software", "the Sample Analytics documentation", "the Mapping data set", "the Translation Memory tool", "the Global Payments library", "the Sample analytics software", "the Sample mobile app"]) {
      expect(await st("licence", { licensedMaterial }), licensedMaterial).toBe("ok");
    }
    for (const propertyAddress of ["12 Sellwood Avenue, Portland", "4 Selly Oak Road, Birmingham", "9 Copley Square, Testville"]) {
      const lease: GenerateInput = { kind: "lease", parties: [{ role: "Landlord", name: "Jane Example" }, { role: "Tenant", name: "Sam Sample" }], terms: { propertyAddress, premisesUse: "residential use only", rentSchedule: "monthly, in advance, on the first day", subletting: "with written consent", rent: "$1,200", deposit: "$1,200", startDate: "2027-02-01", endDate: "2028-01-31", noticeDays: 60, governingLaw: "Example State" } };
      expect((await generateAgreement(lease)).status, propertyAddress).toBe("ok");
    }
  });
  it("Title Case joiners cannot add scope, places or rights, and the material always reads as a quoted name", async () => {
    for (const licensedMaterial of ["the Software In Europe", "the Software For Commercial Use", "the Software For Resale", "the Software To Host", "the Software With Unlimited Users", "the Software Including Updates", "the Software By Subscription", "the Software On Any Device"]) {
      expect(await st("licence", { licensedMaterial }), licensedMaterial).toBe("invalid");
    }
    const grant = (await ok({ ...FULL.licence, terms: { ...FULL.licence.terms, licensedMaterial: "the Sample Stream software" } })).draft.clauses.find((c) => c.id === "grant")!.text;
    expect(grant).toContain('the material known as "the Sample Stream software" in the United Kingdom');
  });
});

describe("review of 9301745: territory is a closed list, material joiners refused", () => {
  const st = async (terms: Record<string, string>) => (await generateAgreement({ ...FULL.licence, terms: { ...FULL.licence.terms, ...terms } })).status;
  const grant = async (territory: string) => (await ok({ ...FULL.licence, terms: { ...FULL.licence.terms, territory } })).draft.clauses.find((c) => c.id === "grant")!.text;
  it("free-text territories that widen or narrow the grant are refused", async () => {
    for (const territory of ["Europe Including Commercial Use", "Europe Including Resale", "Europe Including Rental", "Europe And Affiliates", "Europe For Life", "Europe Free", "Europe Sole", "Europe Excluding France", "The Internet", "Global Markets", "Europe", "Worldwide", "the Low Countries", "Canada and Affiliates", "France;", "France; France", "Georgia"]) {
      expect(await st({ territory }), territory).toBe("invalid");
    }
  });
  it("listed territories, alone or as a list S1 joins itself", async () => {
    expect(await grant("Canada")).toContain('"the Sample Analytics software" in Canada while');
    expect(await grant("United Kingdom")).toContain(" in the United Kingdom while");
    expect(await grant("the European Union")).toContain(" in the European Union while");
    expect(await grant("France; Germany")).toContain(" in France and Germany while");
    expect(await grant("Ontario; Quebec; New York")).toContain(" in Ontario, Quebec and New York while");
    expect(await st({ territory: Array.from({ length: 11 }, (_, i) => ["France", "Spain", "Italy", "Malta", "Ireland", "Poland", "Austria", "Belgium", "Greece", "Sweden", "Finland"][i]).join("; ") })).toBe("invalid");
  });
  it("licensedMaterial cannot carry Excluding/Future/Including/And/With/For/Plus in any case", async () => {
    for (const licensedMaterial of ["Acme Suite And Future Releases", "Acme Suite Excluding Updates", "Acme Suite Including Updates", "Acme Suite With Plugins", "Acme Suite For Teams", "Acme Suite Plus Support", "Acme Suite Or Successor", "Acme Future Suite"]) {
      expect(await st({ licensedMaterial }), licensedMaterial).toBe("invalid");
    }
    expect(await st({ licensedMaterial: "the Acme Suite software" })).toBe("ok");
  });
});


describe("follow-up after 138e2bd: territory case and aliases, material versions", () => {
  const st = async (terms: Record<string, string>) => (await generateAgreement({ ...FULL.licence, terms: { ...FULL.licence.terms, ...terms } })).status;
  const grant = async (territory: string) => (await ok({ ...FULL.licence, terms: { ...FULL.licence.terms, territory } })).draft.clauses.find((c) => c.id === "grant")!.text;
  it("territory matching ignores case and a leading 'the', and accepts full official names", async () => {
    for (const t of ["United States", "the United States", "THE UNITED STATES", "united states", "United States of America"]) expect(await grant(t), t).toContain(" in the United States while");
    expect(await grant("ontario; QUEBEC")).toContain(" in Ontario and Quebec while");
    expect(await st({ territory: "United States; the united states" })).toBe("invalid");
  });
  it("licensedMaterial refuses new, successor, update, release and version words in any case", async () => {
    for (const licensedMaterial of ["Acme Suite New Releases", "the Acme Suite successor software", "Acme Suite Successors", "the Acme Suite updates", "Acme Suite Update", "Acme Suite Release", "Acme Suite Releases", "Acme Suite Version", "the Acme Suite versions", "Acme Suite Upgrades", "version of the Mapping data set"]) {
      expect(await st({ licensedMaterial }), licensedMaterial).toBe("invalid");
    }
  });
});

describe("territory lists may not name a region and a part of it", () => {
  const st = async (territory: string) => (await generateAgreement({ ...FULL.licence, terms: { ...FULL.licence.terms, territory } })).status;
  it("overlaps are refused, distinct neighbours are not", async () => {
    for (const t of ["England and Wales; Wales", "Wales; England and Wales", "the United Kingdom; Scotland", "the European Union; France", "the European Economic Area; the European Union", "Canada; Ontario", "the United States; Texas"]) expect(await st(t), t).toBe("invalid");
    for (const t of ["Virginia; West Virginia", "Ireland; Northern Ireland", "England; Wales", "France; Switzerland"]) expect(await st(t), t).toBe("ok");
  });
});

describe("M2.3 review item 5: no lease or late-fee term the user did not choose", () => {
  const svc: GenerateInput = { kind: "services", parties: [{ role: "Provider", name: "Acme Design Studio" }, { role: "Client", name: "Example Widgets Ltd" }], terms: { fee: "$5,000", paymentDays: 30, startDate: "2027-03-01", noticeDays: 14, governingLaw: "Example State" } };
  const lease: GenerateInput = { kind: "lease", parties: [{ role: "Landlord", name: "Jane Example" }, { role: "Tenant", name: "Sam Sample" }], terms: { propertyAddress: "1 Example Street, Testville", premisesUse: "residential use", rentSchedule: "weekly, in advance", subletting: "permitted", rent: "$300", deposit: "$1,200", startDate: "2027-02-01", endDate: "2028-01-31", noticeDays: 60, governingLaw: "Example State" } };
  const text = async (input: GenerateInput, id: string) => (await ok(input)).draft.clauses.find((c) => c.id === id)!.text;
  it("conditional clause terms: a late fee needs its period, never a default 'per month'", async () => {
    expect(await generateAgreement({ ...svc, terms: { ...svc.terms, lateFeePercent: 1.5 } })).toMatchObject({ status: "needs_input", missing: ["term:lateFeePeriod"] });
    for (const t of Object.values(TEMPLATES)) for (const c of t.clauses.filter((x) => x.when)) {
      for (const m of c.text.matchAll(/\{\{term:([^}]+)\}\}/g)) {
        if (m[1] === c.when || t.requiredTerms.includes(m[1] as TermKey)) continue;
        // Including the clause without that term must ask for it.
        expect(TEMPLATES[t.kind].requiredTerms).not.toContain(m[1]);
      }
    }
    expect(await text({ ...svc, terms: { ...svc.terms, lateFeePercent: 1.5, lateFeePeriod: "month" } }, "late_fee")).toBe("Overdue amounts carry a late fee of 1.5% per month until paid.");
    expect(await text({ ...svc, terms: { ...svc.terms, lateFeePercent: 1.5, lateFeePeriod: "year" } }, "late_fee")).toBe("Overdue amounts carry a late fee of 1.5% per year until paid.");
    expect(await text({ ...svc, terms: { ...svc.terms, lateFeePercent: 5, lateFeePeriod: "once" } }, "late_fee")).toBe("Overdue amounts carry a late fee of 5% of the amount overdue.");
    expect((await generateAgreement({ ...svc, terms: { ...svc.terms, lateFeePeriod: "month" } })).status).toBe("invalid"); // a period without a fee is unused
  });
  it("lease: rent timing, permitted use and subletting are required choices and render as chosen", async () => {
    for (const k of ["rentSchedule", "premisesUse", "subletting"] as const) {
      const terms = { ...lease.terms };
      delete terms[k];
      expect(await generateAgreement({ ...lease, terms }), k).toMatchObject({ status: "needs_input", missing: [`term:${k}`] });
    }
    expect(await text(lease, "rent")).toBe("The Tenant will pay rent of $300 per week, in advance.");
    expect(await text(lease, "premises")).toBe('The Landlord leases to the Tenant the property at 1 Example Street, Testville (the "Premises") for residential use.');
    expect(await text(lease, "use")).toBe("The Tenant will keep the Premises clean, report damage promptly, and may sublet the Premises.");
    const strict = { ...lease, terms: { ...lease.terms, premisesUse: "residential use only", rentSchedule: "monthly, in advance, on the first day", subletting: "not permitted" } };
    expect(await text(strict, "rent")).toBe("The Tenant will pay rent of $300 per month, in advance, on the first day of each month.");
    expect(await text(strict, "premises")).toMatch(/for residential use only\.$/);
    expect(await text(strict, "use")).toBe("The Tenant will keep the Premises clean, report damage promptly, and not sublet the Premises.");
    for (const [k, v] of [["rentSchedule", "monthly"], ["premisesUse", "any use"], ["subletting", "freely"], ["lateFeePeriod", "per month"]] as const) {
      const input = k === "lateFeePeriod" ? { ...svc, terms: { ...svc.terms, lateFeePercent: 1.5, [k]: v } } : { ...lease, terms: { ...lease.terms, [k]: v } };
      expect((await generateAgreement(input)).status, `${k}=${v}`).toBe("invalid");
    }
  });
  it("a model reword cannot change a chosen lease or late-fee term", async () => {
    const strict = { ...lease, terms: { ...lease.terms, premisesUse: "residential use only", subletting: "with written consent" } };
    for (const [id, from, to] of [["premises", "residential use only", "residential use"], ["use", "not sublet without the Landlord's written consent", "may sublet the Premises"], ["rent", "per week", "per month"]]) {
      const r = await ok(strict, stub((cs) => cs.map((c) => (c.id === id ? { id, text: c.text.replace(from, to) } : c))));
      expect(r.source, `${id}: ${from}`).toBe("template");
    }
  });
});

