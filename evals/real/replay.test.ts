// Replays saved real-model responses (REPLAY_FILE, from a paid run) through the current checks. No API calls.
import { describe, it } from "vitest";
import fs from "node:fs";
import { answerWithModel, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import { loadCases } from "@/evals/dataset.mjs";
import { containsFact, normalize as qn } from "@/evals/text.mjs";

const FILE = process.env.REPLAY_FILE ?? "";
describe.skipIf(!FILE)("replay saved real-model responses", () => {
  it("re-checks each saved response", async () => {
    const { rows } = JSON.parse(fs.readFileSync(FILE, "utf8")) as { rows: { id: string; raw: unknown; shown: { status: string } | null }[] };
    const extra = process.env.REPLAY_CASES ? JSON.parse(fs.readFileSync(process.env.REPLAY_CASES, "utf8")) : [];
    type G = { status: string; facts: (string | string[])[]; traps: string[] };
    const cases = new Map([...(loadCases() as { id: string }[]), ...extra].map((c) => [c.id, c as { id: string; question: string; history?: { question: string; answer: string }[]; documents: { id: string; pages: string[] }[]; gold: G }]));
    let correct = 0, withheld = 0, n = 0, trapLeaks = 0;
    for (const r of rows) {
      const c = cases.get(r.id);
      if (!c || !r.raw) continue;
      const p = { name: "replay", model: "replay", complete: async () => JSON.parse(JSON.stringify(r.raw)) };
      const out = await answerWithModel(p, c.question, linesFromText(c.documents[0].pages), QA_LIMITS, { history: c.history ?? [], title: c.documents[0].id });
      n++;
      const text = `${out.answer} ${out.explanation ?? ""}`;
      const ok = c.gold.status === "not_found" ? out.status === "not_found" : out.status !== "not_found" && c.gold.facts.every((f) => containsFact(text, f));
      if (ok) correct++;
      if (out.warnings.some((w) => /isn't shown/.test(w))) withheld++;
      if (c.gold.traps.some((t) => qn(text).includes(qn(t)))) trapLeaks++;
      console.log(`[replay] ${r.id}: was ${r.shown?.status ?? "-"} -> now ${out.status} ${ok ? "OK" : "WRONG"} | ${out.warnings.filter((w) => /isn't shown/.test(w)).join(" / ")}`);
    }
    console.log(`[replay-summary] ${n} responses: shown correct ${correct}/${n}, withheld ${withheld}, trap leaks ${trapLeaks}`);
  });
});
