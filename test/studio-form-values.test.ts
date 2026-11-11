// Agreement Studio form → generator payload: typed numbers are read, not silently dropped (the "it says missing but I
// filled it in" bug: <input type="number"> reported "" for "30 days"), unreadable values are reported against their
// own field, and an edit clears what the last attempt said about that field.
import { describe, expect, it } from "vitest";
import { issueKey, normaliseMoney, parsePercent, parseWhole, termPayload } from "@/components/studio/form-values";
import { kindSpecs } from "@/lib/drafts/service";

const services = kindSpecs().find((k) => k.kind === "services")!;

describe("whole numbers", () => {
  it("reads a bare number or one with the field's own unit", () => {
    expect(parseWhole("30", "noticeDays")).toBe(30);
    expect(parseWhole(" 30 days ", "noticeDays")).toBe(30);
    expect(parseWhole("1 day", "paymentDays")).toBe(1);
    expect(parseWhole("3 years", "confidentialityYears")).toBe(3);
  });
  it("refuses anything that would change the meaning", () => {
    for (const bad of ["30 business days", "net 30", "thirty", "30 years", "-30", "30.5", ""]) expect(parseWhole(bad, "noticeDays"), bad).toBeNull();
  });
});

describe("percent and money", () => {
  it("reads 1.5, 1.5% and 2 %", () => {
    expect(parsePercent("1.5")).toBe(1.5);
    expect(parsePercent("1.5%")).toBe(1.5);
    expect(parsePercent("2 %")).toBe(2);
    expect(parsePercent("one and a half")).toBeNull();
  });
  it("puts a trailing currency code first, and leaves everything else to the generator", () => {
    expect(normaliseMoney("15,000 USD")).toBe("USD 15,000");
    expect(normaliseMoney("15000.50 eur")).toBe("EUR 15000.50");
    expect(normaliseMoney("$15,000")).toBe("$15,000");
    expect(normaliseMoney("15000")).toBe("15000"); // no currency is never guessed
  });
  it("merges a currency symbol and the code it stands for ('$5,000 USD', as Claude copies it)", () => {
    expect(normaliseMoney("$5,000 USD")).toBe("USD 5,000");
    expect(normaliseMoney("USD $5,000")).toBe("USD 5,000");
    expect(normaliseMoney("€1,200.50 eur")).toBe("EUR 1,200.50");
    expect(normaliseMoney("$5,000 CAD")).toBe("CAD 5,000");
  });
  it("leaves a symbol and a code that disagree for the generator to refuse", () => {
    expect(normaliseMoney("$5,000 EUR")).toBe("$5,000 EUR");
    expect(normaliseMoney("£5,000 USD")).toBe("£5,000 USD");
  });
});

describe("termPayload: what Generate sends", () => {
  it("manual entry with units typed: every required field is sent, none dropped as missing", () => {
    const r = termPayload(services, { fee: "15,000 USD", paymentDays: "30 days", startDate: "2027-01-15", noticeDays: "30", governingLaw: "Delaware", feeBasis: "fixed" });
    expect(r.errors).toEqual([]);
    expect(r.terms).toEqual({ fee: "USD 15,000", paymentDays: 30, startDate: "2027-01-15", noticeDays: 30, governingLaw: "Delaware", feeBasis: "fixed" });
  });
  it("AI-populated values (strings, as suggestionToForm sets them) are sent as numbers", () => {
    const r = termPayload(services, { fee: "$15,000", paymentDays: "30", startDate: "2027-01-15", noticeDays: "30", governingLaw: "Delaware", feeBasis: "fixed" });
    expect(r.errors).toEqual([]);
    expect(r.terms.paymentDays).toBe(30);
    expect(r.terms.noticeDays).toBe(30);
  });
  it("an unreadable number is reported against its own field, not as missing", () => {
    const r = termPayload(services, { fee: "$15,000", paymentDays: "net 30", startDate: "2027-01-15", noticeDays: "30", governingLaw: "Delaware" });
    expect(r.errors).toEqual([{ key: "paymentDays", text: "Payment due (days after invoice): enter a whole number of days, like 30." }]);
  });
  it("empty optional fields are simply left out", () => {
    const r = termPayload(services, { fee: "$15,000", paymentDays: "30", startDate: "2027-01-15", noticeDays: "30", governingLaw: "Delaware", endDate: "", lateFeePercent: " " });
    expect(Object.keys(r.terms)).toEqual(["fee", "paymentDays", "startDate", "noticeDays", "governingLaw"]);
  });
});

describe("issueKey: which field a generator issue is about", () => {
  it("maps missing terms, parties and invalid values", () => {
    expect(issueKey("missing: term:noticeDays")).toBe("noticeDays");
    expect(issueKey("missing: party:Client")).toBe("role:Client");
    expect(issueKey("party:Provider: must be a name")).toBe("role:Provider");
    expect(issueKey("fee: expected an amount with a currency, such as $5,000 or USD 5,000.00")).toBe("fee");
  });
});
