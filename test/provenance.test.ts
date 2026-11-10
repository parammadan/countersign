// Figure provenance: a figure or date is QUOTED (the binding agreement), the USER's (the question and earlier turns),
// or DERIVED (a step re-done here whose inputs each have provenance). Derived results aren't rejected for not being in
// the text; invented inputs, wrong arithmetic, wrong dates and wrong weekdays still are. No network.
import { describe, expect, it } from "vitest";
import { checkCalculations, checkClockStep, checkNextWorkingDay, checkSpan, evaluate, recurringDates, stripNotes, weekdayChecks, withoutDates } from "@/lib/qa/check";
import { answerWithModel, QA_LIMITS, type QaResult } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import type { ModelProvider } from "@/lib/understand/model";
import { approveAll } from "./support/stub-verifier";

const AGREEMENT = [
  `LEASE between Larkspur Holdings Ltd ("Landlord") and Fenwick Studio Ltd ("Tenant").
1. Term. The Term Commencement Date is 24 June 2024.
2. Rent. The Initial Rent is £46,500 a year, payable quarterly in advance on the Quarter Days: 25 March, 24 June, 29 September and 25 December.
3. Rent Commencement Date: the date falling 26 weeks after the Term Commencement Date.
4. Invoices. Invoices are payable within 30 days of the invoice date; if that day is not a Working Day, on the next Working Day.
5. Volume pricing. Units 1 to 5,000 in a Contract Year: £38.40 per unit; units 5,001 to 12,000: £35.10 per unit.`,
];
const calc = (calcs: { expression: string; result: string }[], question = "") => checkCalculations(calcs, AGREEMENT, question, "", AGREEMENT);

describe("calendar steps", () => {
  it("a step with notes is re-done, and its dates are derived", () => {
    const r = calc([{ expression: "24 June 2024 + 26 weeks (Rent Commencement Date)", result: "23 December 2024 (a Monday)" }]);
    expect(r.wrong).toEqual([]);
    expect(r.unproven).toEqual([]);
    expect(r.dates).toContain("23 December 2024 (a Monday)".replace(/ \(a Monday\)/, ""));
  });
  it("a wrong date is wrong", () => {
    expect(calc([{ expression: "24 June 2024 + 26 weeks", result: "30 December 2024" }]).wrong).toHaveLength(1);
  });
  it("a base date with no provenance is unproven, so its result isn't derived", () => {
    const r = calc([{ expression: "1 March 2024 + 26 weeks", result: "30 August 2024" }]);
    expect(r.unproven).toHaveLength(1);
    expect(r.dates).toEqual([]);
  });
  it("a count with no provenance is unproven", () => {
    expect(calc([{ expression: "24 June 2024 + 19 weeks", result: "4 November 2024" }]).unproven).toHaveLength(1);
  });
  it("the end of a known date's month is a known base date", () => {
    const r = calc([{ expression: "31 March 2026 + 30 days", result: "30 April 2026" }], "Our invoice is dated 12 March 2026.");
    expect(r.unproven).toEqual([]);
    expect(r.wrong).toEqual([]);
  });
  it("a chain works in any order: a count derived by a later-listed step", () => {
    const r = calc([
      { expression: "24 June 2024 + 182 days", result: "23 December 2024" },
      { expression: "26 weeks * 7", result: "182 days" },
    ]);
    expect(r.wrong).toEqual([]);
    expect(r.recomputed.has("182")).toBe(true);
    expect(r.dates).toContain("23 December 2024");
  });
  it("next working day: a moved date is never re-done here, only a weekday that stays (reviews 26-28)", () => {
    expect(checkNextWorkingDay("Next Working Day after Sunday 5 April 2026", "Tuesday 7 April 2026")).toBeNull();
    expect(checkNextWorkingDay("next business day after 5 April 2026", "6 April 2026")).toBeNull();
    expect(checkNextWorkingDay("Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", "Tuesday 7 April 2026")).toBeNull();
    expect(checkNextWorkingDay("Next Working Day after Tuesday 31 December 2024", "31 December 2024")?.ok).toBe(true);
  });
  it("clock arithmetic", () => {
    expect(checkClockStep("Monday 6:30 a.m. + 72 hours", "Thursday 6:30 a.m.")?.ok).toBe(true);
    expect(checkClockStep("Monday 6:30 a.m. + 72 hours", "Wednesday 6:30 a.m.")?.ok).toBe(false);
    expect(checkClockStep("Monday 08:00 + 4 Working Hours", "Monday 12:00")?.ok).toBe(true);
    // working hours across days need a working calendar: not re-done
    expect(checkClockStep("Friday 15:00 + 4 working hours", "Monday 11:00")).toBeNull();
  });
  it("spans of whole months and of days", () => {
    expect(checkSpan("March 1, 2027 to June 30, 2027", "4 whole calendar months")?.ok).toBe(true);
    expect(checkSpan("March 1, 2027 to June 30, 2027", "5 months")?.ok).toBe(false);
    // days are counted exactly; counting the end day too needs "inclusive"
    expect(checkSpan("1 March 2027 to 31 March 2027", "30 days")?.ok).toBe(true);
    expect(checkSpan("1 March 2027 to 31 March 2027", "31 days")?.ok).toBe(false);
    expect(checkSpan("1 March 2027 to 31 March 2027", "31 days inclusive")?.ok).toBe(true);
  });
  it("weekdays next to dates are checked", () => {
    expect(weekdayChecks("payable on Tuesday 7 April 2026").wrong).toEqual([]);
    expect(weekdayChecks("payable on Monday 7 April 2026").wrong).toHaveLength(1);
    expect(weekdayChecks("February 10, 2029, a Saturday").ok).toHaveLength(1);
  });
  it("a recurring day and month takes only a known year", () => {
    expect(recurringDates("due on 25 December 2024", AGREEMENT[0], ["24 June 2024"])).toEqual(["25 December 2024"]);
    expect(recurringDates("due on 25 December 2031", AGREEMENT[0], ["24 June 2024"])).toEqual([]);
    expect(recurringDates("due on 26 December 2024", AGREEMENT[0], ["24 June 2024"])).toEqual([]);
  });
  it("dates are matched in any format", () => {
    expect(withoutDates("by December 23, 2024 and 2024-12-23", ["23 December 2024"])).not.toMatch(/2024/);
  });
});

describe("arithmetic provenance", () => {
  it("notes and a single unit don't stop the arithmetic", () => {
    expect(stripNotes("12400 * 2% (discount forgone)")).toBe("12400 * 2%");
    expect(evaluate("26 weeks * 7")).toBe(182);
    // mixed units or words aren't arithmetic
    expect(evaluate("10 weeks + 2 days")).toBeNull();
    expect(evaluate("greater of 100000 and 96000")).toBeNull();
  });
  it("a range bound next to a known figure in a label is known", () => {
    const r = calc([{ expression: "4200 + 2500", result: "6,700 cumulative units (units 4,201 to 6,700)" }], "We have ordered 4,200 units and want 2,500 more.");
    expect(r.unproven).toEqual([]);
  });
  it("a chain through the bands, from a user figure and quoted thresholds", () => {
    const r = calc(
      [
        { expression: "5000 - 4200", result: "800 units in the first band" },
        { expression: "800 * 38.40", result: "£30,720.00" },
        { expression: "2500 - 800", result: "1,700 units in the second band (units 5,001 to 6,700)" },
        { expression: "1700 * 35.10", result: "£59,670.00" },
        { expression: "30720 + 59670", result: "£90,390.00" },
      ],
      "We have ordered 4,200 units this year. What will 2,500 more cost?",
    );
    expect(r.wrong).toEqual([]);
    expect([...r.recomputed]).toEqual(expect.arrayContaining(["800", "30720", "1700", "59670", "90390"]));
  });
  it("right arithmetic on an invented input derives nothing", () => {
    const r = calc([{ expression: "4750 * 38.40", result: "£182,400" }], "What will 2,500 units cost?");
    expect(r.recomputed.has("182400")).toBe(false);
  });
  it("wrong arithmetic is wrong", () => {
    expect(calc([{ expression: "800 * 38.40", result: "£30,000" }], "800 units").wrong).toHaveLength(1);
  });
});

describe("end to end, with the verifier", () => {
  const PAGES = linesFromText(AGREEMENT);
  function model(o: { answer: string; explanation?: string; calculations?: { expression: string; result: string }[] }): ModelProvider {
    return {
      name: "scripted",
      model: "claude-opus-5-5",
      complete: async (r) => {
        const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
        return { status: "answered", explanation: "", calculations: [], not_stated: [], ...o, citations: ps.filter((p) => /26 weeks|Term Commencement|Quarter Days/.test(p.text)).map((p) => ({ passage: p.id, quote: p.text.slice(0, 280) })) };
      },
    };
  }
  const ask = (q: string, o: Parameters<typeof model>[0]): Promise<QaResult> => answerWithModel(model(o), q, PAGES, QA_LIMITS, { verifier: approveAll() });
  const shown = (r: QaResult) => !r.warnings.some((w) => /isn['’]t shown/.test(w));
  it("a derived date is shown", async () => {
    const r = await ask("When does rent start?", {
      answer: "Rent starts on 23 December 2024, 26 weeks after the Term Commencement Date of 24 June 2024.",
      calculations: [{ expression: "24 June 2024 + 26 weeks", result: "23 December 2024" }],
    });
    expect(shown(r), r.warnings.join(" / ")).toBe(true);
  });
  it("a yearless Quarter Day put in a year is not a quoted date (review 23)", async () => {
    const r = await ask("When does rent start?", {
      answer: "Rent starts on 23 December 2024, 26 weeks after the Term Commencement Date of 24 June 2024; the next Quarter Day is 25 December 2024.",
      calculations: [{ expression: "24 June 2024 + 26 weeks", result: "23 December 2024" }],
    });
    expect(shown(r)).toBe(false);
  });
  it("a wrong weekday withholds the answer", async () => {
    const r = await ask("When does rent start?", {
      answer: "Rent starts on Friday 23 December 2024, 26 weeks after the Term Commencement Date of 24 June 2024.",
      calculations: [{ expression: "24 June 2024 + 26 weeks", result: "23 December 2024" }],
    });
    expect(shown(r)).toBe(false);
  });
  it("an invented date with no step behind it is withheld", async () => {
    const r = await ask("When does rent start?", { answer: "Rent starts on 2 January 2025, after the Term Commencement Date of 24 June 2024." });
    expect(shown(r)).toBe(false);
  });
});

// Review 22 (independent, of 7aa6485): each was shown with an approve-all verifier at 7aa6485 and withheld at 29e43a5.
describe("R22 provenance can't be laundered", () => {
  const LEASE = linesFromText([`${AGREEMENT[0]}\n6. The Term ends on 23 June 2034.`]);
  function model(o: { answer: string; explanation?: string; calculations?: { expression: string; result: string }[] }): ModelProvider {
    return {
      name: "scripted",
      model: "claude-opus-5-5",
      complete: async (r) => {
        const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
        return { status: "answered", explanation: "", calculations: [], not_stated: [], ...o, citations: ps.filter((p) => /26 weeks|Term|Quarter Days|Volume/.test(p.text)).map((p) => ({ passage: p.id, quote: p.text.slice(0, 280) })) };
      },
    };
  }
  const ask = (q: string, o: Parameters<typeof model>[0]): Promise<QaResult> => answerWithModel(model(o), q, LEASE, QA_LIMITS, { verifier: approveAll() });
  const shown = (r: QaResult) => !r.warnings.some((w) => /isn['’]t shown/.test(w));
  for (const [what, q, o] of [
    ["a span vouching for its own end date", "When does rent start?", { answer: "Rent starts on 24 October 2024.", calculations: [{ expression: "24 June 2024 to 24 October 2024", result: "122 days" }] }],
    ["an 'until' span computing 0 days", "When does the Term end?", { answer: "The Term ends on 30 March 2029.", calculations: [{ expression: "24 June 2024 until 30 March 2029", result: "0 days" }] }],
    ["a skipped 'holiday' far outside the window", "When does the Term end?", { answer: "The Term ends on 1 January 2031.", calculations: [{ expression: "Next Working Day after 24 June 2024, skipping 1 January 2031", result: "25 June 2024" }] }],
    ["invented holidays pushing a deadline", "When does rent start?", { answer: "Rent starts on 30 December 2024.", calculations: [{ expression: "Next Working Day after 23 December 2024, skipping 24 December 2024, 25 December 2024, 26 December 2024 and 27 December 2024", result: "30 December 2024" }] }],
    ["a dated day and month made 'recurring' in another year", "Today is 3 March 2026. When does the Term end?", { answer: "The Term ends on 23 June 2026." }],
    ["a quotation glued to its colon", "Can the Tenant assign?", { answer: 'The lease says:"the Tenant may assign the lease without the Landlord consent".' }],
    ["a period the agreement doesn't use", "What do units cost?", { answer: "Units 1 to 5,000 cost £38.40 per hour." }],
    ["a clock step from an invented start", "When is the inspection?", { answer: "The inspection ends on Saturday 11 a.m.", calculations: [{ expression: "Friday 9 a.m. + 26 hours", result: "Saturday 11 a.m." }] }],
    ["one right weekday hiding another use of its name", "When is rent paid?", { answer: "Rent is paid every Monday; rent starts on Monday 23 December 2024.", calculations: [{ expression: "24 June 2024 + 26 weeks", result: "23 December 2024" }] }],
    ["an off-by-one day span", "How long is March 2027?", { answer: "From 1 March 2027 to 30 March 2027 is 30 days.", calculations: [{ expression: "1 March 2027 to 30 March 2027", result: "30 days" }] }],
  ] as const)
    it(what, async () => {
      expect(shown(await ask(q, { ...o, calculations: o.calculations ? [...o.calculations] : [] }))).toBe(false);
    });
  it("…while a real span between two known dates still derives its count", () => {
    expect(checkSpan("24 June 2024 through 23 December 2024", "182 days")?.ok).toBe(true);
    expect(checkSpan("24 June 2024 until 23 December 2024", "183 days inclusive")?.ok).toBe(true);
  });
});

// Review 23 (independent, of be984e8): each was shown with an approve-all verifier at be984e8 and withheld at 29e43a5.
describe("R23 clock starts, working days and yearless dates", () => {
  const LEASE = linesFromText([`${AGREEMENT[0]}\n6. The Term ends on 23 June 2034.\n7. A notice is deemed served at 9 a.m. on the next Working Day. Inspections may not take place on a Friday. The Tenant may respond within 26 hours.`]);
  function model(o: { answer: string; calculations?: { expression: string; result: string }[] }): ModelProvider {
    return {
      name: "scripted",
      model: "claude-opus-5-5",
      complete: async (r) => {
        const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
        return { status: "answered", explanation: "", not_stated: [], calculations: [], ...o, citations: ps.filter((p) => /notice|Term|Invoices|Quarter/.test(p.text)).map((p) => ({ passage: p.id, quote: p.text.slice(0, 280) })) };
      },
    };
  }
  const ask = (q: string, o: Parameters<typeof model>[0]): Promise<QaResult> => answerWithModel(model(o), q, LEASE, QA_LIMITS, { verifier: approveAll() });
  const shown = (r: QaResult) => !r.warnings.some((w) => /isn['’]t shown/.test(w));
  it("a clock start stitched from a weekday and a time in unrelated clauses", async () => {
    expect(shown(await ask("When must the Tenant respond to a notice served Monday?", { answer: "The Tenant must respond by Saturday 11 a.m.", calculations: [{ expression: "Friday 9 a.m. + 26 hours", result: "Saturday 11 a.m." }] }))).toBe(false);
  });
  it("a next-working-day move from a day that is already a working day", async () => {
    expect(shown(await ask("Our invoice is dated 1 December 2024. When is it due?", { answer: "It is due on 1 January 2025.", calculations: [{ expression: "1 December 2024 + 30 days", result: "31 December 2024" }, { expression: "Next Working Day after 31 December 2024", result: "1 January 2025" }] }))).toBe(false);
    expect(checkNextWorkingDay("Next Working Day after 31 December 2024", "31 December 2024")?.ok).toBe(true);
  });
  it("a derived date listed as its own holiday (review 24)", async () => {
    expect(shown(await ask("Our invoice is dated 1 December 2024. When is it due?", { answer: "It is due on 1 January 2025.", calculations: [{ expression: "1 December 2024 + 30 days", result: "31 December 2024" }, { expression: "Next Working Day after 31 December 2024, skipping 31 December 2024", result: "1 January 2025" }] }))).toBe(false);
  });
  it("a quoted or user base listed as its own holiday (review 25)", async () => {
    const lease = linesFromText([`${AGREEMENT[0]}\n8. The Deposit is payable on 31 December 2024; if that day is not a Working Day, on the next Working Day.`]);
    const r1 = await answerWithModel(model({ answer: "The Deposit is payable on 1 January 2025.", calculations: [{ expression: "Next Working Day after 31 December 2024, skipping 31 December 2024", result: "1 January 2025" }] }), "When is the Deposit payable?", lease, QA_LIMITS, { verifier: approveAll() });
    expect(shown(r1)).toBe(false);
    expect(shown(await ask("Our invoice is due on 31 December 2025. When must we pay?", { answer: "You must pay by 1 January 2026.", calculations: [{ expression: "Next Working Day after 31 December 2025, skipping 31 December 2025", result: "1 January 2026" }] }))).toBe(false);
  });
  it("a holiday step isn't re-done: its date gets no provenance, even from a holiday schedule (review 26)", () => {
    const sched = ["Working Day means Monday to Friday excluding the public holidays in Schedule 2. Schedule 2 public holidays: Good Friday 3 April; Easter Monday 6 April."];
    const r = checkCalculations([{ expression: "Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026", result: "Tuesday 7 April 2026" }], sched, "My invoice was due on 5 April 2026.", "", sched);
    expect(r.dates).not.toContain("Tuesday 7 April 2026");
  });
  for (const clause of ["The Landlord's sales office closed on 24 June 2024.", "Holiday pay for the Landlord's staff is reviewed on 24 June 2024.", "The service charge invoice is dated 24 June 2024; if a payment day is not a Working Day, it moves to the next Working Day."])
    it(`a reused 'holiday' sentence can't move a date: ${clause.slice(0, 40)}… (review 26)`, async () => {
      const lease = linesFromText([`${AGREEMENT[0]}\n7. ${clause}`]);
      const r = await answerWithModel(model({ answer: "You must pay by 25 June 2024.", calculations: [{ expression: "Next Working Day after Sunday 23 June 2024, skipping 24 June 2024", result: "25 June 2024" }] }), "Our invoice is due on Sunday 23 June 2024. When must we pay?", lease, QA_LIMITS, { verifier: approveAll() });
      expect(shown(r)).toBe(false);
    });
  it("a yearless recurring date stated in the user's year as another event", async () => {
    expect(shown(await ask("Today is 3 March 2029. When does the Term end?", { answer: "The Term ends on 24 June 2029." }))).toBe(false);
  });
  it("a clock start that is one phrase in the user's words is known", () => {
    const r = checkCalculations([{ expression: "Monday 6:30 a.m. + 72 hours", result: "Thursday 6:30 a.m." }], AGREEMENT, "It was delivered at 6:30 a.m. on a Monday and the inspection period is 72 hours.", "", AGREEMENT);
    expect(r.unproven).toEqual([]);
    expect(r.dates).toContain("Thursday 6:30 a.m.");
  });
});

// Review 27 (independent, of 4921fa1): a right weekday must not hide its (invented) date; a weekend roll isn't re-done
// where the agreement has holidays.
describe("R27 a weekday doesn't vouch for its date", () => {
  const LEASE = linesFromText([AGREEMENT[0]]);
  function model(o: { answer: string; calculations?: { expression: string; result: string }[] }): ModelProvider {
    return {
      name: "scripted",
      model: "claude-opus-5-5",
      complete: async (r) => {
        const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
        return { status: "answered", explanation: "", not_stated: [], calculations: [], ...o, citations: ps.filter((p) => /26 weeks|Term/.test(p.text)).map((p) => ({ passage: p.id, quote: p.text.slice(0, 280) })) };
      },
    };
  }
  const shown = (r: QaResult) => !r.warnings.some((w) => /isn['’]t shown/.test(w));
  for (const answer of ["Rent starts on Monday 30 December 2024.", "Rent starts on 30 December 2024, a Monday.", "Rent starts on 30 December 2024 (Monday).", "Rent starts on Monday, December 30, 2024."])
    it(answer, async () => {
      expect(shown(await answerWithModel(model({ answer }), "When does rent start?", LEASE, QA_LIMITS, { verifier: approveAll() }))).toBe(false);
    });
  it("a weekend roll is never derived: the agreement's working-day definition may exclude the next weekday (review 28)", async () => {
    const lease = linesFromText([`${AGREEMENT[0]}\n7. Working Day: a day other than a Saturday, Sunday or a day on which banks in London are closed.`]);
    const r = await answerWithModel(model({ answer: "You must pay by 6 April 2026.", calculations: [{ expression: "Next Working Day after Sunday 5 April 2026", result: "6 April 2026" }] }), "Our invoice is due Sunday 5 April 2026. When must we pay?", lease, QA_LIMITS, { verifier: approveAll() });
    expect(shown(r)).toBe(false);
  });
});
