// How each Q&A outcome is labelled on the ask page. Results come from the real pipeline (scripted models, no
// network) wherever it can produce them, so a label can't drift from what lib/qa actually returns.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { answerFromPassages, answerWithModel, QA_LIMITS, QA_STATUS_LABEL, type QaResult } from "@/lib/qa/answer";
import type { VerifiedClaim } from "@/lib/qa/verify";
import { linesFromText } from "@/lib/understand/text";
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";
import { BUDGET_NOTE, FAILED_NOTE, PASSAGES_LABEL, qaKind, qaPresentation } from "@/components/qaPresentation";
import { approveAll, scripted } from "./support/stub-verifier";

const PAGES = linesFromText([
  `CONSULTING AGREEMENT between Harrow Example Ltd ("Provider") and Quill Sample Inc ("Client").
1. Fees. The Client will pay $3,200 per month, payable within 15 days of invoice.
2. Termination. Either party may terminate on 45 days' written notice. Fees already paid are not refundable.
3. Late payment. Overdue amounts accrue interest at 1.5% per month.`,
]);
type Out = { status?: string; answer: string; explanation?: string; not_stated?: string[] };
function model(o: Out, cite?: RegExp): ModelProvider {
  return {
    name: "scripted",
    model: "claude-opus-5-5",
    complete: async (r) => {
      const ps = [...(r.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
      return { status: "answered", explanation: "", calculations: [], not_stated: [], ...o, citations: ps.filter((p) => !cite || cite.test(p.text)).map((p) => ({ passage: p.id, quote: p.text.slice(0, 280) })) };
    },
  };
}
const ask = (q: string, o: Out, verifier: ModelProvider | null, cite?: RegExp): Promise<QaResult> => answerWithModel(model(o, cite), q, PAGES, QA_LIMITS, { verifier });
const evidenceFor = (req: ModelRequest, re: RegExp) => {
  const m = [...(req.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+">([^<]*)<\/passage>/g)].find((x) => re.test(x[2]));
  if (!m) throw new Error(`no passage for ${re}`);
  return { passage: m[1], quote: m[2].slice(0, 200) };
};
type C = Partial<VerifiedClaim> & { claim: string };
const claims = (...cs: ((req: ModelRequest) => C)[]) => scripted((req) => ({ claims: cs.map((f) => ({ kind: "term", material: true, verdict: "supported", evidence: [], reason: "", span: "", ...f(req) })) }));
const fee = (req: ModelRequest) => evidenceFor(req, /\$3,200/);
const labels = (r: QaResult) => qaPresentation(r).badges.map((b) => b.label);
const text = (r: QaResult) => { const p = qaPresentation(r); return [...p.badges.map((b) => b.label), p.how, p.notice ?? ""].join(" | "); };
const SUCCESS = /Verified|checked against the agreement|verified claim by claim/;

describe("withheld answers never look checked", () => {
  it("an invented figure (deterministic block): 'Answer withheld', no success badge or wording", async () => {
    const r = await ask("What is the monthly fee?", { answer: "The Client pays $7,777.13 per month." }, approveAll(), /\$3,200/);
    expect(r.verification).toBeUndefined();
    expect(qaKind(r)).toBe("withheld");
    expect(labels(r)).toEqual(["Answer withheld"]);
    expect(labels(r)).not.toContain(QA_STATUS_LABEL.partial);
    expect(text(r)).not.toMatch(SUCCESS);
    expect(qaPresentation(r).badges[0].tone).toBe("warn");
    expect(qaPresentation(r).how).toMatch(/didn't pass AgreementOS's checks; the passages it relied on are shown instead/);
  });
  it("contradicted by the second check: withheld too", async () => {
    const a = "The Client can terminate without notice.";
    const r = await ask("Can the client terminate without notice?", { answer: a }, claims(() => ({ span: a, claim: a, verdict: "contradicted" })), /terminate/);
    expect(qaKind(r)).toBe("withheld");
    expect(text(r)).not.toMatch(SUCCESS);
  });
  it("withheld with nothing to cite doesn't claim the agreement is silent", () => {
    const r: QaResult = { status: "not_found", answer: "The agreement doesn't appear to address this.", citations: [], mode: "model", model: "claude-opus-5-5", warnings: ["The answer couldn't be tied to the agreement's text, so it isn't shown."] };
    const p = qaPresentation(r);
    expect(p.kind).toBe("withheld");
    expect(p.answer).toMatch(/No answer is shown/);
    expect(p.how).not.toMatch(/passages it relied on/);
  });
});

describe("shown answers say how far they were verified", () => {
  it("every check passed: status plus 'Verified', and the second check named", async () => {
    const a = "The Client will pay $3,200 per month.";
    const r = await ask("What is the fee?", { answer: a }, claims((req) => ({ span: a, claim: "The Client pays $3,200 per month.", evidence: [fee(req)] })), /\$3,200/);
    expect(qaKind(r)).toBe("checked");
    expect(labels(r)).toEqual([QA_STATUS_LABEL.answered, "Verified"]);
    expect(qaPresentation(r).how).toBe("Claude (claude-opus-5-5) · verified claim by claim by a second check (claude-opus-5-5)");
  });
  it("a sentence removed by the checks: 'Part removed', not plain 'Verified'", async () => {
    const note = "The agreement does not say how notices are delivered. Fees already paid are refundable on request.";
    const v = claims(
      (req) => ({ span: "The Client will pay $3,200 per month.", claim: "The Client pays $3,200 per month.", evidence: [fee(req)] }),
      () => ({ span: "The agreement does not say how notices are delivered.", claim: "The agreement does not say how notices are delivered.", kind: "absence" }),
      () => ({ span: "Fees already paid are refundable on request.", claim: "Fees already paid are refundable on request.", verdict: "contradicted" }),
    );
    const r = await ask("What is the fee?", { answer: "The Client will pay $3,200 per month.", not_stated: [note] }, v, /\$3,200/);
    expect(r.verification).toBe("qualified");
    expect(qaKind(r)).toBe("removed");
    expect(labels(r)).toEqual([QA_STATUS_LABEL.answered, "Part removed"]);
    expect(qaPresentation(r).how).toMatch(/partly verified by a second check \(claude-opus-5-5\); a statement it couldn't confirm was removed/);
    expect(text(r)).not.toMatch(/\bVerified\b/);
  });
  it("qualified (a point it couldn't confirm, nothing removed): 'Partly verified'", () => {
    const r: QaResult = { status: "answered", answer: "x", citations: [{ page: 1, passage: "p1-1", quote: "x" }], mode: "model", model: "m", warnings: [], verification: "qualified", unverified: ["much of the answer is worded differently from the quoted text"] };
    expect(qaKind(r)).toBe("qualified");
    expect(labels(r)).toEqual([QA_STATUS_LABEL.answered, "Partly verified"]);
    expect(qaPresentation(r).how).toBe("Claude (m) · partly verified against the agreement");
  });
  it("the model found nothing: 'Not found', without claiming a check", async () => {
    const r = await ask("Is there a warranty on hardware?", { status: "not_found", answer: "The agreement doesn't say." }, approveAll(), /^$/);
    expect(qaKind(r)).toBe("not_found");
    expect(labels(r)).toEqual([QA_STATUS_LABEL.not_found]);
    expect(text(r)).not.toMatch(SUCCESS);
  });
});

describe("passages without AI", () => {
  it("AI off: a neutral 'Relevant passages', not 'Partly answered'", () => {
    const r = answerFromPassages("How much is the fee?", PAGES);
    expect(r.status).toBe("partial");
    const p = qaPresentation(r);
    expect(p.kind).toBe("ai_off");
    expect(p.badges).toEqual([{ label: PASSAGES_LABEL, tone: "neutral" }]);
    expect(p.how).toBe("Quoted passages, no AI");
    expect(p.notice).toBeUndefined();
  });
  it("budget fallback gets its own badge and a notice, not just a small note", () => {
    const r = answerFromPassages("How much is the fee?", PAGES);
    r.warnings.unshift("AI answers have reached today's spending limit, so these are the most relevant passages instead.");
    const p = qaPresentation(r);
    expect(p.kind).toBe("budget");
    expect(p.badges.map((b) => b.label)).toEqual([PASSAGES_LABEL, "AI paused: spending limit"]);
    expect(p.notice).toMatch(/spending limit/);
    expect(p.notes).not.toContain(p.notice);
  });
  it("the model failed: passages, with 'AI unavailable'", () => {
    const r = answerFromPassages("How much is the fee?", PAGES);
    r.warnings.unshift("The AI assistant couldn't answer just now, so these are the most relevant passages instead.");
    const p = qaPresentation(r);
    expect(p.kind).toBe("ai_failed");
    expect(p.badges.map((b) => b.label)).toEqual([PASSAGES_LABEL, "AI unavailable"]);
    expect(p.notice).toMatch(/couldn't answer just now/);
  });
  it("the fallback notes the store writes still match what the page looks for", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/qa/store.ts"), "utf8");
    const notes = [...src.matchAll(/(?:notes\.push|warnings\.unshift)\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(notes.filter((n) => BUDGET_NOTE.test(n))).toHaveLength(2);
    expect(notes.filter((n) => FAILED_NOTE.test(n))).toHaveLength(1);
  });
});
