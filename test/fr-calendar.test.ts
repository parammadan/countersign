// Three narrow calculation checks that add provenance without relaxing anything: a month-and-day step ("January 2026
// + 2 calendar months, on the 10th day"), a working-day roll past dated public holidays, and a zero that follows from a
// stated threshold. Each has positive cases and adversarial ones that must stay wrong or unproven.
import { describe, expect, it } from "vitest";
import { checkCalculations, checkHolidayRoll, checkMonthDayStep, checkThresholdZero } from "@/lib/qa/check";

const run = (steps: [string, string][], agreement: string, question: string) =>
  checkCalculations(steps.map(([expression, result]) => ({ expression, result })), [agreement], question, "", [agreement]);

describe("month-and-day steps", () => {
  it("re-does the step", () => {
    expect(checkMonthDayStep("January 2026 + 2 calendar months, on the 10th day", "March 10, 2026 (first Payment Date)")?.ok).toBe(true);
    expect(checkMonthDayStep("November 2026 + 3 months, on the 31st day", "February 28, 2027")?.ok).toBe(false); // no 31 February
    expect(checkMonthDayStep("January 2026 + 2 calendar months, on the 10th day", "March 11, 2026")?.ok).toBe(false);
    expect(checkMonthDayStep("January 2026 + 2 months", "March 10, 2026")).toBeNull();
  });
  const loan = "4.2 The first Payment Date is the 10th day of the second (2nd) calendar month following the month in which the Disbursement occurs.";
  it("derives the date only from a known month, count and day", () => {
    const ok = run([["January 2026 + 2 calendar months, on the 10th day", "March 10, 2026"]], loan, "The loan is disbursed on January 22, 2026.");
    expect(ok.unproven).toEqual([]);
    expect(ok.dates).toContain("March 10, 2026");
    // no known date in the base month: unproven, and nothing derived
    const noBase = run([["February 2026 + 2 calendar months, on the 10th day", "April 10, 2026"]], loan, "The loan is disbursed on January 22, 2026.");
    expect(noBase.unproven.length).toBe(1);
    expect(noBase.dates).toEqual([]);
    // a day of the month nobody stated
    const noDay = run([["January 2026 + 2 calendar months, on the 15th day", "March 15, 2026"]], loan, "The loan is disbursed on January 22, 2026.");
    expect(noDay.unproven.length).toBe(1);
  });
  it("a monthly series may count N-1 months to the Nth date only when the result names that Nth and N is known", () => {
    const q = "The loan is disbursed on January 22, 2026. On what date is the 36th and final installment due?";
    const chain: [string, string][] = [["January 2026 + 2 calendar months, on the 10th day", "March 10, 2026"]];
    const named = run([...chain, ["March 10, 2026 + 35 months", "February 10, 2029 (36th Payment Date)"]], loan, q);
    expect(named.dates).toContain("February 10, 2029");
    // no ordinal in the result: the count 35 has no provenance
    const bare = run([...chain, ["March 10, 2026 + 35 months", "February 10, 2029"]], loan, q);
    expect(bare.dates).not.toContain("February 10, 2029");
    // an ordinal nobody asked about doesn't make a count known
    const other = run([...chain, ["March 10, 2026 + 47 months", "February 10, 2030 (48th Payment Date)"]], loan, q);
    expect(other.dates).not.toContain("February 10, 2030");
  });
});

describe("working-day rolls past public holidays", () => {
  const dutch = '1.3 "Working Day": Monday to Friday, other than a public holiday listed in Schedule 2. Schedule 2 - Public holidays (2026) New Year\'s Day 1 January; Good Friday 3 April; Easter Monday 6 April; King\'s Day 27 April; Christmas Day 25 December; Boxing Day 26 December.';
  it("re-does a roll against the agreement's own dated list", () => {
    expect(checkHolidayRoll("Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", "Tuesday 7 April 2026", dutch)?.ok).toBe(true);
    // the holiday's date is wrong for that list
    expect(checkHolidayRoll("Next Working Day after Sunday 5 April 2026, skipping Easter Monday 13 April 2026", "Tuesday 14 April 2026", dutch)?.ok).toBe(false);
    // a day the agreement doesn't list is skipped as a "holiday"
    expect(checkHolidayRoll("Next Working Day after Sunday 12 April 2026, skipping Easter Monday 13 April 2026", "Tuesday 14 April 2026", dutch)?.ok).toBe(false);
    // the result lands on a listed holiday the step didn't name
    expect(checkHolidayRoll("Next Working Day after Sunday 26 April 2026, skipping Good Friday 3 April 2026", "Monday 27 April 2026", dutch)?.ok).toBe(false);
    // a holiday the agreement never names, on a date its list gives to another holiday: a false step
    expect(checkHolidayRoll("Next Working Day after Sunday 5 April 2026, skipping Founders Day 6 April 2026", "Tuesday 7 April 2026", dutch)?.ok).toBe(false);
    // the list is for 2026; a 2027 roll isn't dated by it
    expect(checkHolidayRoll("Next Working Day after Sunday 28 March 2027, skipping Easter Monday 29 March 2027", "Tuesday 30 March 2027", dutch)).toBeNull();
  });
  it("a holiday the agreement doesn't date in a list for that year is never re-done here", () => {
    const named = '"Business Day" means a day other than a Saturday, Sunday, Good Friday, Easter Monday or Christmas Day.';
    expect(checkHolidayRoll("Next Business Day after Sunday 28 March 2027, skipping Easter Monday 29 March 2027", "Tuesday 30 March 2027", named)).toBeNull();
    expect(checkHolidayRoll("Next Business Day after Thursday 24 December 2026, skipping Christmas Day 25 December 2026", "Monday 28 December 2026", named)).toBeNull();
  });
  it("in a chain, the roll's dates gain provenance only from a known base", () => {
    const ok = run([["6 March 2026 + 30 days", "5 April 2026"], ["Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", "Tuesday 7 April 2026"]], `${dutch} 4.1 Invoices are payable within thirty (30) days of the invoice date.`, "Lindqvist issues an invoice dated 6 March 2026.");
    expect(ok.wrong).toEqual([]);
    expect(ok.dates).toEqual(expect.arrayContaining(["6 April 2026", "7 April 2026"]));
    const noBase = run([["Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", "Tuesday 7 April 2026"]], dutch, "When is the invoice due?");
    expect(noBase.unproven.length).toBe(1);
    expect(noBase.dates).toEqual([]);
  });
});

describe("a zero that follows from a stated threshold", () => {
  const agency = "5.3 No commission is payable on any order with a Net Invoice Value below €500.";
  it("re-does the comparison and the zero", () => {
    expect(checkThresholdZero("420 < 500, so commission = 0", "€0")?.ok).toBe(true);
    expect(checkThresholdZero("620 < 500, so commission = 0", "€0")?.ok).toBe(false);
    expect(checkThresholdZero("420 < 500, so commission = 0", "€21")?.ok).toBe(false);
    expect(checkThresholdZero("420 < 500", "true")).toBeNull();
  });
  it("lets the zero into a later sum only when the threshold is the agreement's and the input is known", () => {
    const q = "Ardent invoiced a €420 order to a Lisbon customer.";
    const ok = run([["420 < 500, so commission = 0", "€0"], ["4900 + 1400 + 0", "€6,300"]], `${agency} Commission is 7% (€4,900 here) and 3.5% (€1,400 here).`, q);
    expect(ok.unproven.filter((x) => x.startsWith("420"))).toEqual([]);
    // a threshold the agreement doesn't state: unproven
    const made = run([["420 < 600, so commission = 0", "€0"]], agency, q);
    expect(made.unproven.length).toBe(1);
    // an order value nobody stated: unproven
    const noInput = run([["410 < 500, so commission = 0", "€0"]], agency, q);
    expect(noInput.unproven.length).toBe(1);
    // a false comparison is wrong, whatever its inputs
    expect(run([["620 < 500, so commission = 0", "€0"]], agency, "A €620 order.").wrong.length).toBe(1);
  });
});

// Independent review of 813249e: each reproduction, now a regression test
describe("review of the holiday and count rules", () => {
  it("B1: only a holiday list's entries are holidays, not any capitalised phrase with a date", () => {
    const a = "Schedule 2 - Public holidays (2026) Easter Monday 6 April. 7.1 The Supplier shall deliver by the Delivery Date 15 April.";
    expect(checkHolidayRoll("Next Working Day after Tuesday 14 April 2026, skipping Delivery Date 15 April 2026", "Thursday 16 April 2026", a)?.ok).not.toBe(true);
    const r = run([["Next Working Day after Tuesday 14 April 2026, skipping Delivery Date 15 April 2026", "Thursday 16 April 2026"]], a, "The order is placed on 14 April 2026.");
    expect(r.dates).not.toContain("Thursday 16 April 2026");
  });
  it("B2: a list dates holidays only in its own stated year", () => {
    for (const a of ["Public Holidays 2026: Good Friday 3 April; Easter Monday 6 April.", "Public holidays: Good Friday 3 April; Easter Monday 6 April."])
      expect(checkHolidayRoll("Next Working Day after Monday 5 April 2027, skipping Easter Monday 6 April 2027", "Wednesday 7 April 2027", a)?.ok).not.toBe(true);
  });
  it("B3: two yearly lists keep their own years", () => {
    const a = "Public holidays (2026) Good Friday 3 April; Easter Monday 6 April. Public holidays (2027) Good Friday 26 March; Easter Monday 29 March.";
    expect(checkHolidayRoll("Next Working Day after Wednesday 25 March 2026, skipping Good Friday 26 March 2026", "Friday 27 March 2026", a)?.ok).not.toBe(true);
    expect(checkHolidayRoll("Next Working Day after Thursday 25 March 2027, skipping Good Friday 26 March 2027", "Monday 29 March 2027", a)?.ok).toBe(false); // 29 March 2027 is Easter Monday
  });
  it("B4: a named holiday falls inside the roll, and the result is never a holiday", () => {
    const a = '"Business Day" means a day other than a Saturday, Sunday, Good Friday, Easter Monday or Christmas Day.';
    expect(checkHolidayRoll("Next Business Day after Thursday 24 December 2026, skipping Easter Monday 6 April 2026", "Friday 25 December 2026", a)?.ok).not.toBe(true);
    expect(checkHolidayRoll("Next Business Day after Thursday 2 April 2026, skipping Easter Monday 6 April 2026", "Friday 3 April 2026", a)?.ok).not.toBe(true);
    expect(checkHolidayRoll("Next Business Day after Thursday 24 December 2026, skipping Christmas Day 25 December 2026", "Monday 28 December 2026", a)).toBeNull();
  });
  it("B5: an undated holiday must be in the working-day definition, not just mentioned", () => {
    const a = '"Business Day" means Monday to Friday. No sales on Christmas Day.';
    expect(checkHolidayRoll("Next Business Day after Thursday 24 December 2026, skipping Christmas Day 25 December 2026", "Monday 28 December 2026", a)?.ok).not.toBe(true);
  });
  it("B6: the Nth must be a note outside the date, and N in the question", () => {
    const r = run([["March 11, 2026 + 10 months", "January 11th, 2027"]], "The term is twelve months.", "The contract starts March 11, 2026.");
    expect(r.dates).not.toContain("January 11th, 2027");
    expect(r.unproven.length).toBe(1);
  });
});

// Second independent review of the holiday, zero and count rules: each reproduction, now a regression test
describe("second review", () => {
  const ask = (steps: [string, string][], agreement: string, q: string) => run(steps, agreement, q);
  it("Z1: a zero needs the clause's own direction (below is strictly below)", () => {
    const a = "No commission is payable on any order with a Net Invoice Value below €500. Otherwise commission is 7%.";
    expect(checkThresholdZero("500 <= 500, so commission = 0", "€0", a)?.rule).toBe(false);
    expect(ask([["500 <= 500, so commission = 0", "€0"]], a, "A €500 order.").unproven.length).toBe(1);
    expect(checkThresholdZero("420 < 500, so commission = 0", "€0", a)?.rule).toBe(true);
  });
  it("Z2: the threshold must be the term's own zero rule, not any figure", () => {
    const a = "Commission is 7% of Net Invoice Value. The Agent's liability is capped at €1,000.";
    expect(ask([["420 < 1000, so commission = 0", "€0"]], a, "A €420 order.").unproven.length).toBe(1);
  });
  it("a checked zero is only ever the verifier's to judge (never an operand shown on its own)", () => {
    const a = "No commission is payable on any order with a Net Invoice Value below €500.";
    const r = ask([["420 < 500, so commission = 0", "€0"]], a, "A €420 order.");
    expect(r.recomputed.has("0")).toBe(true);
    expect(r.operands.has("0")).toBe(false);
  });
  it("C1/C2: the Nth must be an ordinal in the question, not a date's day or part of a decimal", () => {
    const twelve = "The Loan is repaid in twelve monthly instalments.";
    const c1 = ask([["March 11, 2026 + 10 months", "January 11, 2027 (the 11th instalment)"]], twelve, "The Start Date is March 11, 2026.");
    expect(c1.dates).not.toContain("January 11, 2027");
    const c2 = ask([["March 10, 2026 + 35 months", "February 10, 2029 (36th Payment Date)"]], "4.2 The first Payment Date is March 10, 2026.", "Interest is 4.36% a year. When is the last payment?");
    expect(c2.dates).not.toContain("February 10, 2029");
  });
  it("N1/N2/N7: a holiday list is only its own run of entries, and never an illustration", () => {
    const n1 = "Public holidays (2026): Easter Monday 6 April; King's Day 27 April. The Supplier shall deliver by the Delivery Date 15 April.";
    expect(checkHolidayRoll("Next Working Day after Tuesday 14 April 2026, skipping Delivery Date 15 April 2026", "Thursday 16 April 2026", n1)?.ok).not.toBe(true);
    const n2 = "Public holidays (2026): Good Friday 3 April; Easter Monday 6 April. In 2027 the holidays are Good Friday 26 March.";
    expect(checkHolidayRoll("Next Working Day after Wednesday 25 March 2026, skipping Good Friday 26 March 2026", "Friday 27 March 2026", n2)?.ok).not.toBe(true);
    const n7 = "For illustration only, public holidays (2026) such as Founders Day 15 April are not excluded.";
    expect(checkHolidayRoll("Next Working Day after Tuesday 14 April 2026, skipping Founders Day 15 April 2026", "Thursday 16 April 2026", n7)).toBeNull();
  });
  it("N3: a roll that leaves the list's year isn't re-done", () => {
    const both = "Public holidays (2026): Christmas Day 25 December; Boxing Day 26 December. Public holidays (2027): New Year's Day 1 January.";
    expect(checkHolidayRoll("Next Working Day after Wednesday 30 December 2026, skipping New Year's Eve 31 December 2026", "Friday 1 January 2027", both)).toBeNull();
  });
  it("N4-N6: there is no undated mode, so definitions with catch-alls or included holidays can't bless a roll", () => {
    for (const a of ['"Business Day" means a day other than a Saturday, Sunday, Christmas Day, Boxing Day or any other day on which banks in London are closed.', '"Business Day" means Monday to Friday; no sales are made on Christmas Day.', '"Business Day" means a day other than a Saturday or Sunday (Christmas Day and Boxing Day are Business Days).'])
      expect(checkHolidayRoll("Next Business Day after Thursday 24 December 2026, skipping Christmas Day 25 December 2026", "Monday 28 December 2026", a)).toBeNull();
  });
  it("a curly apostrophe in a listed name is the same name", () => {
    const a = "Public holidays (2026): King’s Day 27 April; Liberation Day 5 May.";
    expect(checkHolidayRoll("Next Working Day after Sunday 26 April 2026, skipping King’s Day 27 April 2026", "Tuesday 28 April 2026", a)?.ok).toBe(true);
  });
});

// Third independent review: each reproduction, now a regression test
describe("third review", () => {
  it("H1: a holiday list that doesn't end cleanly is not read at all", () => {
    const step = ["Next Working Day after Thursday 2 April 2026, skipping Good Friday 3 April 2026", "Monday 6 April 2026"] as const;
    for (const a of [
      "Public holidays (2026): Good Friday 3 April and Easter Monday 6 April.",
      "Public holidays (2026):\nGood Friday 3 April\nEaster Monday 6 April.",
      "Public holidays (2026): Good Friday 3 April (Tuesday 7 April as a substitute day); Easter Monday 6 April.",
      "Public holidays (2026): Good Friday 3 April; Day after Easter 6 April.",
      "Public holidays (2026): New Year's Day 1 January, Good Friday 3 April and Easter Monday 6 April.",
    ]) expect(checkHolidayRoll(step[0], step[1], a)?.ok, a).not.toBe(true);
    // a clean list followed by more text still reads
    expect(checkHolidayRoll("Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", "Tuesday 7 April 2026", "Public holidays (2026): Good Friday 3 April; Easter Monday 6 April. 7.1 Notices must be in writing.")?.ok).toBe(true);
  });
  it("Z3: the term is a whole word", () => {
    expect(checkThresholdZero("420 < 500, so commission = 0", "€0", "Commissioning of any system below €500 is not required.")?.rule).toBe(false);
  });
  it("Z4: the negation governs the term, and hedged sentences never count", () => {
    for (const a of [
      "No commission is payable unless the order is below €500.",
      "Commission is not reduced for orders below €500.",
      "Commission is payable on all orders, including orders below €500, and no minimum order value applies.",
      "No commission is payable on orders below €500, except where the Principal agrees otherwise.",
    ]) expect(checkThresholdZero("420 < 500, so commission = 0", "€0", a)?.rule, a).toBe(false);
    expect(checkThresholdZero("420 < 500, so commission = 0", "€0", "Commission shall not be payable on any order below €500.")?.rule).toBe(true);
  });
  it("O1: a series count only runs from a first date the agreement's rule produced", () => {
    const loan = "4.2 The first Payment Date is the 10th day of the second (2nd) calendar month following the month in which the Disbursement occurs.";
    const q = "The loan is disbursed on January 22, 2026. On what date is the 36th and final installment due?";
    const r = run([["January 22, 2026 + 35 months", "December 22, 2028 (36th installment)"]], loan, q);
    expect(r.dates).not.toContain("December 22, 2028");
  });
  it("O2: the ordinal names the installment, in the question and in the result's note", () => {
    const loan = "4.2 The first Payment Date is the 10th day of the second (2nd) calendar month following the month in which the Disbursement occurs.";
    const chain: [string, string][] = [["January 2026 + 2 calendar months, on the 10th day", "March 10, 2026"]];
    const other = run([...chain, ["March 10, 2026 + 35 months", "February 10, 2029 (36th installment)"]], loan, "The loan is disbursed on January 22, 2026 under the Bank's 36th standard form. When is the final installment due?");
    expect(other.dates).not.toContain("February 10, 2029");
    const right = run([...chain, ["March 10, 2026 + 35 months", "February 10, 2029 (36th installment)"]], loan, "The loan is disbursed on January 22, 2026 at 4.36% a year. When is the 36th installment due?");
    expect(right.dates).toContain("February 10, 2029");
  });
  it("N7: other illustrative phrasings aren't lists", () => {
    for (const a of ["For instance, bank holidays 2026: Founders Day 15 April; Easter Monday 6 April.", "Were the parties to agree, public holidays (2026): Founders Day 15 April."])
      expect(checkHolidayRoll("Next Working Day after Tuesday 14 April 2026, skipping Founders Day 15 April 2026", "Thursday 16 April 2026", a)).toBeNull();
  });
});
