// Realistic descriptions + realistic model outputs through cleanSuggestion: stated values survive, guesses don't.
import { describe, expect, it } from "vitest";
import { cleanSuggestion } from "@/lib/drafts/service";

const run = (desc: string, terms: [string, string][], kind = "consulting") =>
  cleanSuggestion({ kind, parties: [], terms: terms.map(([key, value]) => ({ key, value })), clarifications: [] }, desc);

describe("dates written the way people write them", () => {
  it("keeps abbreviated months and 'the 15th of January'", () => {
    expect(run("Starts Jan 15, 2027.", [["startDate", "2027-01-15"]]).terms.startDate).toBe("2027-01-15");
    expect(run("Starts 15 Sept. 2027.", [["startDate", "2027-09-15"]]).terms.startDate).toBe("2027-09-15");
    expect(run("Starts the 15th of January, 2027.", [["startDate", "2027-01-15"]]).terms.startDate).toBe("2027-01-15");
  });
  it("still drops a date the description does not write", () => {
    expect(run("Starts Jan 15, 2027.", [["startDate", "2027-01-16"]]).terms.startDate).toBeUndefined();
    expect(run("Starts Jan 2027.", [["startDate", "2027-01-01"]]).terms.startDate).toBeUndefined();
  });
});

describe("fee basis is kept only when the description says it about the fee", () => {
  it("a late-fee 'per month' does not make a one-time fee monthly", () => {
    expect(run("$12,000 one-time. Late fee 1.5% per month.", [["fee", "$12,000"], ["feeBasis", "month"]]).terms.feeBasis).toBeUndefined();
    expect(run("$12,000 flat fee. Late fee 1.5% per month.", [["feeBasis", "fixed"]]).terms.feeBasis).toBe("fixed");
  });
  it("'a fixed term of 6 months' is not a fixed fee", () => {
    expect(run("$12,000 for a fixed term of 6 months", [["feeBasis", "fixed"]]).terms.feeBasis).toBeUndefined();
  });
  it("a month's notice is not a monthly fee", () => {
    expect(run("$5,000 total, give a month's notice", [["feeBasis", "month"]]).terms.feeBasis).toBeUndefined();
    expect(run("$5,000 a month, one month's notice", [["feeBasis", "month"]]).terms.feeBasis).toBe("month");
  });
});
