// Review 7 timing probe (opt-in: PG=30 npx vitest run test/review-r7-perf.test.ts). A long agreement and an answer
// with an acronym: before the fix, 42.7 s (strict) and 51.2 s (with the verifier); after, about 7 s, most of it the
// source-attachment loop that predates the verifier. Not run by default: timings don't belong in CI.
import { describe, it } from "vitest";
import { answerWithModel, derivableFrom, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import type { ModelProvider } from "@/lib/understand/model";
import { approveAll } from "./support/stub-verifier";

const words = ["service", "level", "agreement", "supplier", "customer", "deliver", "goods", "premises", "notice", "credit", "invoice", "warranty", "period", "standard", "acceptance", "report", "monthly", "review", "meeting", "minutes"];
const clause = (i: number) => `${i}. Clause ${i}. The Supplier shall ${Array.from({ length: 45 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")} within ${100 + i} days and pay ${1000 + i * 17} dollars.`;
const pages = linesFromText(Array.from({ length: Number(process.env.PG ?? 40) }, (_, p) => Array.from({ length: 12 }, (_, j) => clause(p * 12 + j)).join("\n")));
const cite = (o: { answer: string; explanation: string }): ModelProvider => ({
  name: "s", model: "claude-opus-5-5",
  complete: async (r) => {
    const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)];
    console.log("context chars", (r.context ?? "").length, "passages", ps.length);
    return { status: "answered", calculations: [], not_stated: [], ...o, citations: [{ passage: ps[0][1], quote: ps[0][2].slice(0, 200) }] };
  },
});
describe.skipIf(!process.env.PG)("timing probe", () => {
for (const verifier of [null, "v"] as const)
  it(`timing, verifier=${verifier}`, async () => {
    const o = { answer: "The Supplier must deliver within 100 days.", explanation: process.env.NOACR ? "Under the agreement, the Supplier delivers within 101 days, 102 days, 103 days, 104 days, 105 days and 106 days." : "Under the SLA, the Supplier delivers within 101 days, 102 days, 103 days, 104 days, 105 days and 106 days." };
    const t = Date.now();
    const r = await answerWithModel(cite(o), "When must the Supplier deliver under the SLA?", pages, QA_LIMITS, { verifier: verifier ? approveAll() : null });
    console.log("verifier", verifier, "ms", Date.now() - t, r.warnings.slice(-1), r.citations.length);
  }, 600_000);
it("derivableFrom worst case", () => {
  const d = derivableFrom(Array.from({ length: 500 }, (_, i) => String(1000 + i * 17)));
  const t = Date.now();
  for (let i = 0; i < 300; i++) d(String(9_999_999 + i));
  console.log("derivable 300 misses ms", Date.now() - t);
});
});
