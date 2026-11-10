import { describe, expect, it } from "vitest";
import { cleanSuggestion, kindSpecs } from "@/lib/drafts/service";

describe("Agreement Studio: AI suggestions never invent values", () => {
  const desc = "A consulting agreement between Northwind Advisory LLC (consultant) and Acme Corp (client), $12,000 fee, payable within 30 days, starting 2027-01-15, Delaware law.";
  it("keeps only values stated in the description", () => {
    const s = cleanSuggestion({
      kind: "consulting",
      parties: [{ role: "Consultant", name: "Northwind Advisory LLC" }, { role: "Client", name: "Globex Holdings" }],
      terms: [
        { key: "fee", value: "$12,000" }, { key: "paymentDays", value: "30" }, { key: "governingLaw", value: "Delaware" },
        { key: "noticeDays", value: "14" }, { key: "governingLaw", value: "New York" }, { key: "startDate", value: "2027-01-15" },
        { key: "ipOwner", value: "client" }, { key: "exclusivity", value: "made-up" }, { key: "notAKey", value: "x" },
      ],
      unclear: ["notice period"],
    }, desc);
    expect(s.kind).toBe("consulting");
    expect(s.parties).toEqual([{ role: "Consultant", name: "Northwind Advisory LLC" }]); // Globex is not in the text
    expect(s.terms.fee).toBe("$12,000");
    expect(s.terms.paymentDays).toBe("30");
    expect(s.terms.noticeDays).toBeUndefined(); // 14 is not stated
    expect(s.terms.governingLaw).toBe("Delaware"); // the invented New York is dropped
    expect(s.terms.startDate).toBe("2027-01-15");
    expect(s.unclear).toEqual(["notice period"]);
    expect(Object.keys(s.terms)).not.toContain("notAKey");
  });
  it("malformed model output gives an empty suggestion, not an error", () => {
    for (const raw of [null, "x", 42, [], { kind: "spaceship", parties: "no", terms: {} }]) {
      expect(cleanSuggestion(raw, desc)).toEqual({ kind: null, parties: [], terms: {}, unclear: [] });
    }
  });
  it("choice terms must be one of the listed choices", () => {
    const s = cleanSuggestion({ kind: "licence", parties: [], terms: [{ key: "exclusivity", value: "exclusive" }, { key: "licensedUse", value: "anything" }], unclear: [] }, "licence");
    expect(Object.keys(s.terms)).toEqual(Object.keys(s.terms).filter((k) => k !== "licensedUse"));
  });
});

describe("Agreement Studio: the form lists every template's required terms", () => {
  it("each kind has two roles and its required terms", () => {
    const specs = kindSpecs();
    expect(specs.map((k) => k.kind).sort()).toEqual(["consulting", "engagement", "lease", "licence", "nda", "retainer", "services"]);
    for (const k of specs) {
      expect(k.roles).toHaveLength(2);
      expect(k.terms.filter((t) => t.required).length).toBeGreaterThan(0);
    }
  });
});

describe("integration review B3: substrings, unstated dates and inherited keys are refused", () => {
  const desc = "An NDA between Northwind Advisory LLC and Acme Corp starting 2027-01-15, confidentiality for 30 years, fee $50,000, Delaware law.";
  it("whole-token values only", () => {
    const s = cleanSuggestion({
      kind: "nda",
      parties: [{ role: "Disclosing Party", name: "A" }, { role: "Receiving Party", name: "Corp" }, { role: "x", name: "Acme Corp" }],
      terms: [
        { key: "confidentialityYears", value: "3" }, { key: "confidentialityYears", value: "30" }, { key: "fee", value: "$5" }, { key: "fee", value: "$50" },
        { key: "startDate", value: "1999-12-31" }, { key: "endDate", value: "2099-01-01" }, { key: "exclusivity", value: "constructor" },
        { key: "constructor", value: "length" }, { key: "toString", value: "name" }, { key: "__proto__", value: "x" },
      ],
      unclear: [],
    }, desc);
    expect(s.parties.map((p) => p.name)).toEqual(["Acme Corp"]); // "A" too short, "Corp" is part of "Acme Corp"
    expect(s.terms.confidentialityYears).toBe("30");
    expect(s.terms.fee).toBeUndefined();
    expect(s.terms.startDate).toBeUndefined();
    expect(s.terms.endDate).toBeUndefined();
    expect(s.terms.exclusivity).toBeUndefined();
    expect(Object.keys(s.terms).sort()).toEqual(["confidentialityYears"]);
  });
  it("a date is kept only if the description writes it, in ISO or words", () => {
    expect(cleanSuggestion({ terms: [{ key: "startDate", value: "2027-01-15" }] }, "starting 2027-01-15").terms.startDate).toBe("2027-01-15");
    expect(cleanSuggestion({ terms: [{ key: "startDate", value: "2027-01-15" }] }, "starting January 15, 2027").terms.startDate).toBe("2027-01-15");
    expect(cleanSuggestion({ terms: [{ key: "startDate", value: "2027-01-15" }] }, "starting 15th January 2027").terms.startDate).toBe("2027-01-15");
    expect(cleanSuggestion({ terms: [{ key: "startDate", value: "2027-01-16" }] }, "starting January 15, 2027").terms.startDate).toBeUndefined();
  });
  it("$12,000 is kept whole; $12 is not taken from it", () => {
    expect(cleanSuggestion({ terms: [{ key: "fee", value: "$12,000" }] }, "fee $12,000").terms.fee).toBe("$12,000");
    expect(cleanSuggestion({ terms: [{ key: "fee", value: "$12" }] }, "fee $12,000").terms.fee).toBeUndefined();
  });
});

