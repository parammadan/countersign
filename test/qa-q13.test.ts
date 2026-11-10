// The Q13 evaluation harness (evals/) run against AgreementOS's Q&A, with no network and no paid model.
// It measures AgreementOS's CHECKS, not a model's quality: the "models" here are scripted from Q13's gold data.
//   - passages mode (no AI): citations, source recall, abstention;
//   - checks given a correct answer: how often a right answer is wrongly withheld;
//   - checks given an adversarial answer: planted claims, and a wrong figure that exists elsewhere in the cited text.
// This is the development set (the fixes were made while looking at it). Unseen results come from the sealed set.
import { describe, it, expect } from "vitest";
import { answerFromPassages, answerWithModel } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import { normalize } from "@/lib/understand/evidence";
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";
import { loadCases } from "@/evals/dataset.mjs";
import { scoreRun } from "@/evals/metrics.mjs";
import { normalize as q13normalize, containsFact } from "@/evals/text.mjs";

type Fact = string | string[];
type Case = {
  id: string; category: string; question: string; documents: { id: string; pages: string[] }[];
  gold: { status: string; answer: string; facts: Fact[]; distractors: Fact[]; sources: { docId: string; page: number; quote: string }[]; traps: string[] };
};
const SINGLE: Case[] = (loadCases() as Case[]).filter((c) => c.documents.length === 1);
const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const words = (f: Fact) => (Array.isArray(f) ? f[0] : f);
const passagesOf = (r: ModelRequest) => [...((r.context ?? "") + r.document).matchAll(/<passage id="([^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
const scripted = (f: (ps: { id: string; text: string }[]) => unknown): ModelProvider => ({ name: "scripted", model: "scripted", complete: async (r) => f(passagesOf(r)) });
const asQ13 = (docId: string, r: { status: string; answer: string; citations: { page: number; quote: string }[] }) => ({ status: r.status, answer: r.answer, citations: r.citations.map((c) => ({ docId, page: c.page, quote: c.quote })) });

describe("Q13 harness: AgreementOS checks on the development set (52 single-agreement cases)", () => {
  it("passages mode: citations always verbatim, no trap leaks; abstention reported", () => {
    const answers = SINGLE.map((c) => asQ13(c.documents[0].id, answerFromPassages(c.question, linesFromText(c.documents[0].pages))));
    const { overall, byCategory } = scoreRun(SINGLE, answers) as unknown as { overall: Record<string, number | null>; byCategory: Record<string, Record<string, number | null>> };
    console.log(`[passages] citations ${pct(overall.citationAccuracy)} sourceRecall ${pct(overall.sourceRecall)} abstentionRecall ${pct(overall.abstentionRecall)} (${byCategory.abstention.cases} cases) trapLeak ${pct(overall.trapLeakRate)}`);
    expect(overall.citationAccuracy).toBe(1);
    expect(overall.trapLeakRate).toBe(0);
    expect(overall.sourceRecall).toBeGreaterThanOrEqual(0.9);
    expect(overall.abstentionRecall).toBeGreaterThanOrEqual(0.75);
  });

  it("a correct answer is shown (not wrongly withheld)", async () => {
    let shown = 0, total = 0;
    const missed: string[] = [];
    for (const c of SINGLE.filter((c) => c.gold.status !== "not_found")) {
      total++;
      const p = scripted((ps) => ({
        status: c.gold.status,
        answer: c.gold.answer,
        citations: c.gold.sources.map((s) => ({ passage: ps.find((x) => normalize(x.text).includes(normalize(s.quote)))?.id ?? "p0-0", quote: s.quote })),
      }));
      const r = await answerWithModel(p, c.question, linesFromText(c.documents[0].pages));
      if (r.status !== "not_found" && c.gold.facts.every((f) => containsFact(r.answer, f))) shown++;
      else missed.push(`${c.id}: ${r.warnings.join(" / ")}`);
    }
    console.log(`[correct answers shown] ${shown}/${total}${missed.length ? "\n  " + missed.join("\n  ") : ""}`);
    expect(shown / total).toBeGreaterThanOrEqual(0.95);
  });

  it("an adversarial answer: planted claims and wrong figures from elsewhere in the cited text are withheld", async () => {
    let traps = 0, trapLeaks = 0, swaps = 0, swapsShown = 0;
    const shownIds: string[] = [];
    for (const c of SINGLE) {
      const pages = linesFromText(c.documents[0].pages);
      for (const trap of c.gold.traps) {
        traps++;
        const p = scripted((ps) => {
          const cite = ps.find((x) => q13normalize(x.text).includes(q13normalize(trap))) ?? ps[0];
          return { status: "answered", answer: `According to the agreement, the ${trap}.`, citations: [{ passage: cite.id, quote: cite.text.slice(0, 120) }] };
        });
        if (q13normalize((await answerWithModel(p, c.question, pages)).answer).includes(q13normalize(trap))) trapLeaks++;
      }
      const fact = c.gold.facts[0];
      const wrong = c.gold.distractors[0];
      if (c.gold.status !== "not_found" && fact && wrong && c.gold.answer.includes(words(fact))) {
        swaps++;
        const p = scripted((ps) => ({
          status: "answered",
          answer: c.gold.answer.split(words(fact)).join(words(wrong)),
          citations: ps.filter((x) => containsFact(x.text, wrong) || containsFact(x.text, fact)).slice(0, 3).map((x) => ({ passage: x.id, quote: x.text.slice(0, 200) })),
        }));
        const r = await answerWithModel(p, c.question, pages);
        if (r.answer.includes(words(wrong)) && !r.answer.includes(words(fact))) { swapsShown++; shownIds.push(c.id); }
      }
    }
    console.log(`[adversarial] trap leaks ${trapLeaks}/${traps}; wrong-figure swaps shown ${swapsShown}/${swaps}${shownIds.length ? ` (${shownIds.join(", ")})` : ""}`);
    expect(trapLeaks).toBe(0);
    expect(swapsShown).toBeLessThanOrEqual(2);
  });
});
