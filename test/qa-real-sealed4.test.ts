// Sealed set 4 (run once, 2026-11-09, at frozen 29e43a5) is now development data: its 100 real generator outputs and
// 83 real verifier outputs are replayed with no network. A ratchet: correct answers shown can't drop, the
// deterministic checks can't withhold more correct answers than now, and no trap phrase is shown except where the
// answer refutes it (reviewed by hand). Rows without saved verifier output (the checks withheld them at run time) are
// counted separately: if the checks now pass, the verifier's verdict is unknown offline.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerWithModel, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import { containsFact, normalize as qn } from "@/evals/text.mjs";

type Case = { id: string; category: string; question: string; history?: { question: string; answer: string }[]; documents: { id: string; pages: string[] }[]; gold: { status: string; facts: (string | string[])[]; traps: string[] } };
const ROWS: { case: Case; raw: unknown; verifyRaw?: unknown }[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures/qa-real/sealed4-dev.json"), "utf8"));
// the trap phrase appears only where the answer refutes it, disclaims non-binding text, or (s4-012) explains why a
// clause is overridden; reviewed by hand
const REFUTES_TRAP = new Set(["s4-005", "s4-009", "s4-012", "s4-016", "s4-019", "s4-020", "s4-028", "s4-032", "s4-033", "s4-043", "s4-065", "s4-076", "s4-080"]);

describe("sealed set 4 replay (development data)", () => {
  it("shows at least as many correct answers, withholds no more, and leaks no trap", async () => {
    let shownCorrect = 0;
    let unknown = 0;
    const withheldByChecks: string[] = [];
    const leaks: string[] = [];
    for (const { case: c, raw, verifyRaw } of ROWS) {
      let reached = false;
      const r = await answerWithModel(
        { name: "g", model: "claude-opus-5-5", complete: async () => JSON.parse(JSON.stringify(raw)) },
        c.question, linesFromText(c.documents[0].pages), QA_LIMITS,
        { history: c.history ?? [], title: c.documents[0].id, verifier: { name: "v", model: "claude-opus-5-5", complete: async () => { reached = true; if (!verifyRaw) throw new Error("no saved verifier output"); return JSON.parse(JSON.stringify(verifyRaw)); } } },
      );
      if (!verifyRaw && reached) { unknown++; continue; }
      if (!r.verifiedBy && !reached) withheldByChecks.push(c.id);
      if (!r.verifiedBy) continue;
      const text = `${r.answer} ${r.explanation ?? ""}`;
      const ok = c.gold.status === "not_found" ? r.status === "not_found" : r.status !== "not_found" && c.gold.facts.every((f) => containsFact(text, f));
      if (ok) shownCorrect++;
      if (c.gold.traps.some((t) => qn(text).includes(qn(t))) && !REFUTES_TRAP.has(c.id)) leaks.push(c.id);
    }
    console.log(`[sealed4-dev] shown correct ${shownCorrect} (auto-graded), withheld by checks ${withheldByChecks.length} (${withheldByChecks.join(", ")}), verifier unknown ${unknown}`);
    expect(leaks).toEqual([]);
    expect(shownCorrect).toBeGreaterThanOrEqual(74);
    // 8: review 22 kept the period-word check hard (s4-007, "hour" for 30-minute blocks), trading one false rejection
    // for protection against wrong periods periodConflicts can't see
    expect(withheldByChecks.length).toBeLessThanOrEqual(8);
  });
});
