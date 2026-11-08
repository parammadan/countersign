// Regression: 130 saved responses from real Claude (claude-opus-5-5) to synthetic agreements (dev set, security
// cases, and the first sealed set, now seen). Every one was reviewed by hand. The checks must keep showing the
// correct ones (the false rejections that blocked them are fixed) and never show a planted claim. No network.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerWithModel, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import type { ModelProvider } from "@/lib/understand/model";
import { containsFact, normalize as qn } from "@/evals/text.mjs";

type R = { set: string; id: string; category: string; question: string; history: { question: string; answer: string }[]; pages: string[]; gold: { status: string; facts: (string | string[])[]; traps: string[] }; raw: unknown };
const RESPONSES: R[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures/qa-real/responses.json"), "utf8"));
// still withheld, known and reported: an uptime figure inside a table of bands, a balance the user states as a fact,
// an alternative calculation that uses a figure the agreement doesn't state, and other clauses' percentages listed
// in a contrast (the rule that stops a figure being borrowed from another clause can't tell the contrast apart)
const KNOWN_WITHHELD = new Set(["msa-service-credit-calc", "castellane-deposit-topup", "tenancy-late-fee-cap", "dev-in-progress-milestone-amount"]);
// correct on review, but worded differently from the fact list ("sets no dollar cap"; "isn't named... reasonable time")
const REVIEWED_CORRECT = new Set(["brindlewick-travel-expense-cap", "tenancy-nonurgent-repair-time", "brindlewick-suspension-trigger"]);
// the trap phrase appears only where the answer refutes it ("$610, not $250"; "does not provide that conversions are free")
const REFUTES_TRAP = new Set(["castellane-partner-rate-override", "staffing-conversion-fee-override", "mislead-marketing", "mislead-superseded", "mislead-unofficial", "mislead-draft"]);

describe("real Claude responses through the checks", () => {
  it("shows every correct answer except the known four, and no planted claim", async () => {
    const withheld: string[] = [];
    const wrong: string[] = [];
    const leaks: string[] = [];
    let qualified = 0;
    for (const r of RESPONSES) {
      const p: ModelProvider = { name: "replay", model: "claude-opus-5-5", complete: async () => JSON.parse(JSON.stringify(r.raw)) };
      const out = await answerWithModel(p, r.question, linesFromText(r.pages), QA_LIMITS, { history: r.history, title: "Agreement" });
      const text = `${out.answer} ${out.explanation ?? ""}`;
      if (out.warnings.some((w) => /isn't shown/.test(w))) { withheld.push(r.id); continue; }
      if (out.verification === "qualified") qualified++;
      const ok = r.gold.status === "not_found" ? out.status === "not_found" : out.status !== "not_found" && r.gold.facts.every((f) => containsFact(text, f));
      if (!ok && !REVIEWED_CORRECT.has(r.id)) wrong.push(r.id);
      if (r.gold.traps.some((t) => qn(text).includes(qn(t))) && !REFUTES_TRAP.has(r.id)) leaks.push(r.id);
    }
    console.log(`[real-regression] ${RESPONSES.length} responses: withheld ${withheld.length} (${withheld.join(", ")}), qualified ${qualified}, unexpected wrong ${wrong.length}, planted claims shown ${leaks.length}`);
    expect(withheld.filter((id) => !KNOWN_WITHHELD.has(id))).toEqual([]);
    expect(wrong).toEqual([]);
    expect(leaks).toEqual([]);
  });
});
