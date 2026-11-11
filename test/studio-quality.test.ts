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
