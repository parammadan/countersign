// Real Claude outputs from both passes (claude-opus-5-5 answering, claude-opus-5-5 verifying), saved from the paid
// dev and smoke runs on synthetic agreements: replayed through the checks with no network. These are the dev set, so
// they were used to calibrate the rules (not an independent result). Correct answers must be shown, apart from the
// known few; nothing the generator got wrong (none here) may be shown.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerWithModel, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import type { ModelProvider } from "@/lib/understand/model";
import { loadCases } from "@/evals/dataset.mjs";

type Row = { id: string; raw: unknown; verifyRaw: unknown };
type Case = { id: string; question: string; history?: { question: string; answer: string }[]; documents: { id: string; pages: string[] }[] };
const ROWS: Row[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures/qa-real/verified-dev.json"), "utf8"));
const CASES = new Map((loadCases() as Case[]).map((c) => [c.id, c]));
// withheld although correct: a claim the verifier itself contradicted, a negative claim ("none of the retainers is a
// referral fee") it gave no evidence for, one sentence no judged claim covered, and "the agreement doesn't restrict
// either party from competing" (a negated restriction is judged as a term, which needs evidence)
const KNOWN = new Set(["abstain-arbitration-seat", "abstain-referral-fee", "ambiguous-termination-material", "abstain-non-compete"]);

const replay = (x: unknown): ModelProvider => ({ name: "replay", model: "claude-opus-5-5", complete: async () => JSON.parse(JSON.stringify(x)) });

describe("real two-pass outputs (dev set, calibrated)", () => {
  it("shows the correct answers apart from the known few", async () => {
    const withheld: string[] = [];
    let shown = 0;
    for (const r of ROWS) {
      const c = CASES.get(r.id);
      if (!c || !r.verifyRaw) continue;
      const out = await answerWithModel(replay(r.raw), c.question, linesFromText(c.documents[0].pages), QA_LIMITS, { history: c.history ?? [], title: c.documents[0].id, verifier: replay(r.verifyRaw) });
      if (out.verifiedBy) shown++;
      else withheld.push(r.id);
    }
    console.log(`[real-verified] ${ROWS.length} rows: shown ${shown}, withheld ${withheld.length} (${withheld.join(", ")})`);
    expect(withheld.filter((id) => !KNOWN.has(id))).toEqual([]);
  });
});
