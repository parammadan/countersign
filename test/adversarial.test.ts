// The adversarial suite (evals/adversarial): deliberately incorrect answers and correct controls, each with an honest
// and a fooled verifier output, replayed through the checks with no network. A ratchet on what is displayed: with an
// honest verifier no incorrect claim is shown; with a fooled one, no more than now (see the README for what that
// measures and why the suite is development data).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerWithModel, QA_LIMITS } from "@/lib/qa/answer";
import { linesFromText } from "@/lib/understand/text";
import type { ModelRequest } from "@/lib/understand/model";

type Ev = { passage: string; quote: string };
type VOut = { claims: { span: string; claim: string; kind: string; material: boolean; verdict: string; evidence: Ev[]; reason: string }[] };
type Case = {
  id: string; agreement: string; question: string; history?: { question: string; answer: string }[]; arm: "wrong" | "control"; errorType: string;
  generator: { status: string; answer: string; explanation: string; calculations: { expression: string; result: string }[]; not_stated: string[]; citations: Ev[] };
  wrongPhrases: string[]; verifier: { honest: VOut; fooled: VOut };
};
const SUITE = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals/adversarial/cases.json"), "utf8")) as { agreements: { id: string; pages: string[] }[]; cases: Case[] };
const ws = (s: string) => s.replace(/‹/g, "<").replace(/›/g, ">").replace(/\s+/g, " ").trim();
// "auto": the passage the model was shown that holds the quote (none: an id that doesn't check out)
function resolve(req: ModelRequest, evs: Ev[]): Ev[] {
  const ps = [...`${req.context ?? ""}\n${req.document ?? ""}`.matchAll(/<passage id="(p[^"]+)" page="\d+"[^>]*>([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
  return evs.map((e) => (e.passage !== "auto" ? e : { passage: ps.find((x) => ws(x.text).includes(ws(e.quote)))?.id ?? "p0-0", quote: e.quote }));
}
async function run(c: Case, arm: "honest" | "fooled") {
  const doc = SUITE.agreements.find((a) => a.id === c.agreement)!;
  const res = await answerWithModel(
    { name: "g", model: "claude-opus-5-5", complete: async (req) => ({ ...c.generator, citations: resolve(req, c.generator.citations) }) },
    c.question, linesFromText(doc.pages), QA_LIMITS,
    { history: c.history ?? [], title: doc.id, verifier: { name: "v", model: "claude-opus-5-5", complete: async (req) => ({ claims: c.verifier[arm].claims.map((x) => ({ ...x, evidence: resolve(req, x.evidence) })) }) } },
  );
  const shown = !!res.verifiedBy || /doesn't appear to address this/.test(res.answer);
  const displayed = shown ? ws([res.answer, res.explanation ?? "", ...(res.calculations ?? []).map((x) => `${x.expression} = ${x.result}`), ...(res.notStated ?? [])].join(" \n ")) : "";
  return { shown, leaked: c.wrongPhrases.some((p) => displayed.includes(ws(p))) };
}

describe("adversarial suite (development data)", () => {
  it("honest verifier: no incorrect claim displayed, and the correct controls are shown", async () => {
    const leaks: string[] = [];
    const hidden: string[] = [];
    for (const c of SUITE.cases) {
      const r = await run(c, "honest");
      if (r.leaked) leaks.push(c.id);
      if (c.arm === "control" && !r.shown) hidden.push(c.id);
    }
    expect(leaks).toEqual([]);
    // k-17: the balance is derived from a deposit the answer never computes ("€48,000 − €14,400"; 14,400 isn't stated)
    expect(hidden).toEqual(["k-17"]);
  });
  it("fooled verifier: no more incorrect claims displayed than measured (23 of 70)", async () => {
    const leaks: string[] = [];
    for (const c of SUITE.cases.filter((x) => x.arm === "wrong")) if ((await run(c, "fooled")).leaked) leaks.push(c.id);
    console.log(`[adversarial] fooled verifier: ${leaks.length} of 70 incorrect claims displayed`);
    expect(leaks.length).toBeLessThanOrEqual(23);
    // what the hard checks alone stop, whatever the verifier says: non-binding text as a term, invented figures, wrong
    // arithmetic and dates, terms smuggled into absences
    expect(leaks.filter((id) => /^(?:nb|it|wa|wd|st)-/.test(id))).toEqual([]);
  });
});
