// A weekday not written right next to its date is accepted only when it is tied to exactly one date that has
// provenance, and is right for it. Everything else stays as before (an invented detail).
import { describe, expect, it } from "vitest";
import { anchoredWeekdays } from "@/lib/qa/check";

const known = new Set(["2029-02-10", "2026-04-05", "2026-04-06", "2026-03-06"]);
describe("weekdays tied to a known date", () => {
  it("accepts a correct weekday for the date just written", () => {
    expect(anchoredWeekdays("The 36th installment falls on February 10, 2029. That date is a Saturday.", known).ok).toEqual(["That date is a Saturday"]);
    expect(anchoredWeekdays("6 March 2026 is a Friday, so 5 April is a Sunday.", known).ok).toEqual(["5 April is a Sunday"]);
    expect(anchoredWeekdays("Because February 10, 2029 falls on a Saturday, payment moves.", known).ok).toEqual(["February 10, 2029 falls on a Saturday"]);
    expect(anchoredWeekdays("February 10, 2029 (36th Payment Date, a Saturday)", known).ok).toHaveLength(1);
  });
  it("a wrong weekday is wrong, never accepted", () => {
    const r = anchoredWeekdays("The installment falls on February 10, 2029. That date is a Friday. 5 April is a Monday.", known);
    expect(r.ok).toEqual([]);
    expect(r.wrong).toHaveLength(2);
  });
  it("a date without provenance gives a weekday no support", () => {
    const r = anchoredWeekdays("Payment is due on March 3, 2029. That date is a Saturday. 3 March is a Saturday.", known);
    expect(r.ok).toEqual([]);
    expect(r.wrong).toEqual([]);
  });
  it("a day and month that matches two known dates is ambiguous", () => {
    const two = new Set(["2026-04-05", "2027-04-05"]);
    expect(anchoredWeekdays("5 April is a Sunday.", two).ok).toEqual([]);
  });
  it("a date two sentences back isn't the referent", () => {
    const r = anchoredWeekdays("It falls on February 10, 2029. Interest is simple. Fees are fixed. That date is a Saturday.", known);
    expect(r.ok).toEqual([]);
  });
  it("the nearest earlier date is the referent, not one the model hopes for", () => {
    // the date right before is unknown, so the weekday gets no support even though a known date appears earlier
    const r = anchoredWeekdays("On February 10, 2029 the plan ends; the bank closes on March 3, 2029. That date is a Saturday.", known);
    expect(r.ok).toEqual([]);
  });
  it("a standalone weekday with no date stays unsupported", () => {
    const r = anchoredWeekdays("None fall on Saturday night or Sunday.", known);
    expect(r).toEqual({ ok: [], wrong: [] });
  });
});
