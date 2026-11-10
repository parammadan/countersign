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
