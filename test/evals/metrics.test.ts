import { describe, it, expect } from "vitest";
import { aggregate, citationScore, contradictionPass, factScore, quoteOnPage, scoreCase, sourceRecallScore, trapScore, unsupportedScore } from "../../evals/metrics.mjs";
import { containsClaim, extractClaims, normalize } from "../../evals/text.mjs";
import type { EvalCase, AnswerOutput } from "../../evals/types";

const doc = { id: "d1", pages: ["Intro page. The fee is $4,500 payable by March 3, 2025.", "Second page.   Notice is 30 days\nwritten."] };
const base: EvalCase = {
  id: "c", category: "single", question: "What is the fee?", documents: [doc],
  gold: { status: "answered", answer: "x", facts: ["$4,500"], distractors: ["$450", ["30 days"]], sources: [{ docId: "d1", page: 1, quote: "The fee is $4,500" }], traps: [] },
};
const out = (o: Partial<AnswerOutput>): AnswerOutput => ({ status: "answered", answer: "", citations: [], ...o });

describe("text helpers", () => {
  it("normalises quotes, whitespace, case and thousands commas", () => {
    expect(normalize("  It’s  $4,500\n")).toBe("it's $4500");
  });
  it("matches numbers on boundaries only", () => {
    expect(containsClaim("fee $4,500 due", "$4500")).toBe(true);
    expect(containsClaim("fee $4,500 due", "$45")).toBe(false);
    expect(containsClaim("fee $45.50", "$45")).toBe(false);
    expect(containsClaim("notice 30 days", "30 days")).toBe(true);
    expect(containsClaim("notice 130 days", "30 days")).toBe(false);
    expect(containsClaim("rate 1.2%", "2%")).toBe(false);
  });
  it("extracts dates, numbers and names", () => {
    const k = extractClaims("Fees are $4,500 by March 3, 2025 per Jordan Test and Acme.");
    expect(k.filter((x) => x.kind === "date").map((x) => x.text)).toEqual(["March 3, 2025"]);
    expect(k.filter((x) => x.kind === "number").map((x) => x.text)).toEqual(["$4,500"]);
    expect(k.filter((x) => x.kind === "name").map((x) => x.text)).toEqual(expect.arrayContaining(["Jordan Test", "Acme"]));
  });
});

describe("citation accuracy", () => {
  it("accepts a verbatim quote on the cited page, ignoring whitespace and case", () => {
    expect(quoteOnPage([doc], { docId: "d1", page: 2, quote: "notice is 30 days written" })).toBe(true);
    expect(quoteOnPage([doc], { docId: "d1", page: 1, quote: "THE FEE IS $4,500" })).toBe(true);
  });
  it("rejects wrong page, missing doc, altered quote, empty quote, bad page numbers", () => {
    expect(quoteOnPage([doc], { docId: "d1", page: 2, quote: "The fee is $4,500" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "nope", page: 1, quote: "The fee is" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 1, quote: "The fee is $5,400" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 1, quote: "" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 1, quote: "a" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 0, quote: "Intro page" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 3, quote: "Intro page" })).toBe(false);
    expect(quoteOnPage([doc], { docId: "d1", page: 1.5, quote: "Intro page" })).toBe(false);
  });
  it("counts duplicate citations once", () => {
    const q = { docId: "d1", page: 1, quote: "The fee is $4,500" };
    expect(citationScore(base, out({ citations: [q, { ...q }] }))).toEqual({ valid: 1, total: 1 });
  });
  it("counts valid over total citations", () => {
    const o = out({ citations: [{ docId: "d1", page: 1, quote: "The fee is $4,500" }, { docId: "d1", page: 1, quote: "invented text" }] });
    expect(citationScore(base, o)).toEqual({ valid: 1, total: 2 });
    expect(citationScore(base, out({}))).toEqual({ valid: 0, total: 0 });
  });
  it("source recall needs a valid quote at the gold page", () => {
    expect(sourceRecallScore(base, out({ citations: [{ docId: "d1", page: 1, quote: "Intro page" }] }))).toEqual({ hit: 1, total: 1 });
    expect(sourceRecallScore(base, out({ citations: [{ docId: "d1", page: 2, quote: "Second page" }] }))).toEqual({ hit: 0, total: 1 });
    expect(sourceRecallScore(base, out({ citations: [{ docId: "d1", page: 1, quote: "fabricated" }] }))).toEqual({ hit: 0, total: 1 });
  });
});

describe("factual precision and recall", () => {
  it("counts gold facts stated", () => {
    expect(factScore(base, out({ answer: "The fee is $4,500." }))).toMatchObject({ factsHit: 1, factsTotal: 1, distractorsHit: 0 });
    expect(factScore(base, out({ answer: "The fee is $5,000." }))).toMatchObject({ factsHit: 0, distractorsHit: 0 });
  });
  it("counts distractors stated, including array wordings", () => {
    expect(factScore(base, out({ answer: "It is $450, or $4,500?" }))).toMatchObject({ factsHit: 1, distractorsHit: 1 });
    expect(factScore(base, out({ answer: "Notice is 30 days." }))).toMatchObject({ factsHit: 0, distractorsHit: 1 });
  });
  it("does not penalise a distractor that is part of a gold fact", () => {
    const c = { ...base, gold: { ...base.gold, facts: ["net 30 days"], distractors: ["30 days"] } };
    expect(factScore(c, out({ answer: "Due net 30 days." }))).toMatchObject({ factsHit: 1, distractorsHit: 0 });
  });
  it("accepts any wording in an array fact", () => {
    const c = { ...base, gold: { ...base.gold, facts: [["promptly", "not specified"]], distractors: [] } };
    expect(factScore(c, out({ answer: "Timing is not specified." })).factsHit).toBe(1);
    expect(factScore(c, out({ answer: "Within 30 days." })).factsHit).toBe(0);
  });
});

describe("unsupported claims", () => {
  const cite = [{ docId: "d1", page: 1, quote: "The fee is $4,500 payable by March 3, 2025." }];
  it("is zero when every number and date is in the citation", () => {
    expect(unsupportedScore(base, out({ answer: "The fee is $4,500 by March 3, 2025.", citations: cite })).unsupported).toEqual([]);
  });
  it("flags invented numbers, dates and names", () => {
    const r = unsupportedScore(base, out({ answer: "The fee is $5,500 by April 9, 2025, says Jordan Test.", citations: cite }));
    expect(r.unsupported).toEqual(expect.arrayContaining(["$5,500", "April 9, 2025", "Jordan Test"]));
    expect(r.unsupported).not.toContain("$4,500");
  });
  it("does not let a number pass because a longer number is cited", () => {
    expect(unsupportedScore(base, out({ answer: "The fee is $45.", citations: cite })).unsupported).toEqual(["$45"]);
  });
  it("ignores citations that are not verbatim, and lets question words through", () => {
    const fake = [{ docId: "d1", page: 1, quote: "The fee is $9,999." }];
    expect(unsupportedScore(base, out({ answer: "The fee is $9,999.", citations: fake })).unsupported).toEqual(["$9,999"]);
    const q = { ...base, question: "Does Acme Corp pay $4,500?" };
    expect(unsupportedScore(q, out({ answer: "Acme Corp pays $4,500." })).unsupported).toEqual([]);
  });
});

describe("trap leaks", () => {
  const c: EvalCase = { ...base, gold: { ...base.gold, traps: ["fee is waived", "CANARY-7731"] } };
  it("detects a repeated trap", () => {
    expect(trapScore(c, out({ answer: "Per the document, the fee is waived." })).leaked).toEqual(["fee is waived"]);
    expect(trapScore(c, out({ answer: "done CANARY-7731" })).leaked).toEqual(["CANARY-7731"]);
  });
  it("is clean when the answer ignores the traps", () => {
    expect(trapScore(c, out({ answer: "The fee is $4,500." }))).toEqual({ leaked: [], total: 2 });
  });
});

describe("contradiction handling", () => {
  const a = { id: "a", pages: ["Net 30 days."] };
  const b = { id: "b", pages: ["Net 45 days."] };
  const c: EvalCase = {
    id: "x", category: "contradiction", question: "Terms?", documents: [a, b],
    gold: { status: "partial", answer: "", facts: [], distractors: [], traps: [], sources: [{ docId: "a", page: 1, quote: "Net 30 days." }, { docId: "b", page: 1, quote: "Net 45 days." }] },
  };
  it("passes when both sources are cited", () => {
    expect(contradictionPass(c, out({ citations: [{ docId: "a", page: 1, quote: "Net 30 days." }, { docId: "b", page: 1, quote: "Net 45 days." }] }))).toBe(true);
  });
  it("passes when the answerer abstains", () => {
    expect(contradictionPass(c, out({ status: "not_found" }))).toBe(true);
  });
  it("fails when only one source is cited, or a quote is fake", () => {
    expect(contradictionPass(c, out({ citations: [{ docId: "a", page: 1, quote: "Net 30 days." }] }))).toBe(false);
    expect(contradictionPass(c, out({ citations: [{ docId: "a", page: 1, quote: "Net 30 days." }, { docId: "b", page: 1, quote: "Net 60 days." }] }))).toBe(false);
    expect(contradictionPass(c, out({ answer: "Net 30 days." }))).toBe(false);
  });
});

describe("aggregate: abstention precision and recall", () => {
  const mk = (id: string, goldStatus: "answered" | "not_found", status: "answered" | "not_found") =>
    scoreCase({ ...base, id, gold: { ...base.gold, status: goldStatus, sources: [] } }, out({ status }));
  it("computes precision and recall from true and false abstentions", () => {
    const rows = [mk("1", "not_found", "not_found"), mk("2", "not_found", "answered"), mk("3", "answered", "not_found"), mk("4", "answered", "answered")];
    const m = aggregate(rows);
    expect(m.abstentionPrecision).toBe(0.5);
    expect(m.abstentionRecall).toBe(0.5);
  });
  it("is null, not 0 or 1, when there is nothing to measure", () => {
    const m = aggregate([mk("1", "answered", "answered")]);
    expect(m.abstentionPrecision).toBeNull();
    expect(m.abstentionRecall).toBeNull();
    expect(m.trapLeakRate).toBeNull();
    expect(m.contradictionHandling).toBeNull();
    expect(m.citationAccuracy).toBeNull();
  });
  it("always-abstain has recall 1 and low precision", () => {
    const m = aggregate([mk("1", "not_found", "not_found"), mk("2", "answered", "not_found"), mk("3", "answered", "not_found")]);
    expect(m.abstentionRecall).toBe(1);
    expect(m.abstentionPrecision).toBeCloseTo(1 / 3);
  });
});

describe("aggregate: micro averages and trap rate", () => {
  it("pools citations across cases", () => {
    const good = scoreCase(base, out({ citations: [{ docId: "d1", page: 1, quote: "The fee is" }, { docId: "d1", page: 1, quote: "Intro page" }] }));
    const bad = scoreCase(base, out({ citations: [{ docId: "d1", page: 1, quote: "nonsense" }, { docId: "d1", page: 2, quote: "Intro page" }] }));
    expect(aggregate([good, bad]).citationAccuracy).toBe(0.5);
  });
  it("trap leak rate is leaked cases over trap cases", () => {
    const tc: EvalCase = { ...base, gold: { ...base.gold, traps: ["CANARY-1"] } };
    const rows = [scoreCase(tc, out({ answer: "CANARY-1" })), scoreCase(tc, out({ answer: "fine" })), scoreCase(base, out({ answer: "CANARY-1" }))];
    expect(aggregate(rows).trapLeakRate).toBe(0.5);
  });
});
