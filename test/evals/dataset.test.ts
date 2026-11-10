import { describe, it, expect } from "vitest";
import { loadCases } from "../../evals/dataset.mjs";
import { containsClaim } from "../../evals/text.mjs";
import { quoteOnPage, unsupportedScore } from "../../evals/metrics.mjs";
import type { EvalCase } from "../../evals/types";

const cases = loadCases() as EvalCase[];
const by = (c: string) => cases.filter((x) => x.category === c);

describe("dataset integrity", () => {
  it("meets the required sizes", () => {
    expect(by("single").length).toBeGreaterThanOrEqual(30);
    expect(by("multi").length).toBeGreaterThanOrEqual(10);
    for (const c of ["abstention", "contradiction", "ambiguous", "injection"]) expect(by(c).length).toBeGreaterThanOrEqual(6);
  });
  it("has unique ids, single-document and multi-document shapes", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of by("single")) expect(c.documents).toHaveLength(1);
    for (const c of by("multi")) expect(c.documents.length).toBeGreaterThanOrEqual(2);
  });
  it("every gold source quote is verbatim on its page", () => {
    for (const c of cases) for (const s of c.gold.sources) expect(quoteOnPage(c.documents, s), `${c.id}: ${s.quote}`).toBe(true);
  });
  it("every gold fact appears in a gold quote, and answerable cases have sources", () => {
    for (const c of cases) {
      if (c.gold.status === "not_found") {
        expect(c.gold.sources, c.id).toEqual([]);
        expect(c.gold.facts, c.id).toEqual([]);
        continue;
      }
      expect(c.gold.sources.length, c.id).toBeGreaterThan(0);
      const quotes = c.gold.sources.map((s) => s.quote).join("\n");
      for (const f of c.gold.facts) {
        // ambiguous cases list wordings of "unclear"; at least one wording must be derivable from the quote or the gold answer
        const wordings = Array.isArray(f) ? f : [f];
        expect(wordings.some((w) => containsClaim(quotes + "\n" + c.gold.answer, w)), `${c.id}: ${wordings}`).toBe(true);
      }
    }
  });
  it("multi-document and contradiction cases have sources in at least two documents", () => {
    for (const c of [...by("multi"), ...by("contradiction")]) expect(new Set(c.gold.sources.map((s) => s.docId)).size, c.id).toBeGreaterThanOrEqual(2);
  });
  it("contradiction documents really disagree on the cited page", () => {
    for (const c of by("contradiction")) {
      const [a, b] = c.gold.sources;
      expect(a.quote).not.toBe(b.quote);
    }
  });
  it("trap cases plant the trap in a document and never in the gold answer or quotes", () => {
    const traps = by("injection");
    expect(traps.length).toBeGreaterThanOrEqual(6);
    for (const c of traps) {
      expect(c.gold.traps.length, c.id).toBeGreaterThan(0);
      const text = c.documents.flatMap((d) => d.pages).join("\n");
      for (const t of c.gold.traps) {
        expect(containsClaim(text, t) || text.toLowerCase().includes(t.toLowerCase()), `${c.id}: ${t} planted`).toBe(true);
        expect(containsClaim(c.gold.answer, t), `${c.id}: ${t} in gold answer`).toBe(false);
        for (const s of c.gold.sources) expect(containsClaim(s.quote, t), `${c.id}: ${t} in gold quote`).toBe(false);
      }
    }
  });
  it("uses only synthetic identities", () => {
    const text = JSON.stringify(cases);
    const emails = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g) ?? [];
    for (const e of emails) expect(e).toMatch(/@example\.(com|test)$/);
    expect(text).not.toMatch(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/);
  });
  it("gold answers make no unsupported claims", () => {
    for (const c of cases) {
      const r = unsupportedScore(c, { status: c.gold.status, answer: c.gold.answer, citations: c.gold.sources });
      expect(r.unsupported, c.id).toEqual([]);
    }
  });
});
