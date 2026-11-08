// Two-pass answers in the store: both calls are booked before either is made, both costs are recorded, and a
// verifier that fails without reporting usage keeps its worst case. Hand-built database, synthetic agreement.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-qa-verify-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

describe("two-pass answers: booking and recording both calls", () => {
  let db: typeof import("../lib/db");
  let Q: typeof import("../lib/qa/store");
  let P: typeof import("../lib/ai/pricing");
  let A: typeof import("../lib/qa/answer");
  let V: typeof import("../lib/qa/verify");
  let vid = "";
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));

  // answers with the first passage, quoted; reports usage
  const answerer: ModelProvider = {
    name: "fake",
    model: "claude-opus-5-5",
    complete: async (r) => {
      r.onUsage?.({ inputTokens: 300, outputTokens: 500, cacheWriteTokens: 4000, cacheReadTokens: 0 });
      const m = (r.context ?? "").match(/<passage id="(p[^"]+)" page="\d+">([^<]{20,})<\/passage>/)!;
      return { status: "answered", answer: m[2].slice(0, 60), citations: [{ passage: m[1], quote: m[2].slice(0, 60) }] };
    },
  };
  // supports each sentence of the answer with the first binding passage
  const verifier = (usage: boolean): ModelProvider => ({
    name: "fake-verifier",
    model: "claude-opus-5-5",
    complete: async (r) => {
      if (usage) r.onUsage?.({ inputTokens: 5000, outputTokens: 800 });
      const m = (r.context ?? "").match(/<passage id="(p[^"]+)" page="\d+">([^<]{20,})<\/passage>/)!;
      const text = /<text>([\s\S]*?)<\/text>/.exec(r.document)![1];
      return { claims: [{ claim: text, kind: "term", material: true, verdict: "supported", evidence: [{ passage: m[1], quote: m[2].slice(0, 40) }], reason: "" }] };
    },
  });

  beforeAll(async () => {
    db = await import("../lib/db");
    Q = await import("../lib/qa/store");
    P = await import("../lib/ai/pricing");
    A = await import("../lib/qa/answer");
    V = await import("../lib/qa/verify");
    const files = await import("../lib/files");
    const T = await import("../lib/templates");
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      "ws_v", "Firm V", "Firm V LLC", "Firm V", "Avery Tester", "avery-v@example.com", "inb_v", new Date().toISOString(),
    );
    vid = (await T.ingestAgreement(files.getWorkspace("ws_v"), { data: pdfBytes, filename: "engagement.pdf" }, { actor: "a@example.com" })).version.id;
  });

  it("records both calls: tokens summed, each priced at its model", async () => {
    await Q.askQuestion("ws_v", vid, { id: "u_a", email: "a@example.com" }, "What are the payment terms?", answerer, null, verifier(true));
    const row = db.one<{ cost_microusd: number; input_tokens: number; output_tokens: number; result_json: string }>("SELECT cost_microusd, input_tokens, output_tokens, result_json FROM qa_answers WHERE asked_by = 'a@example.com'")!;
    // answer: 300 x $4 + 500 x $20 + 4000 x $5 = $0.0312; verifier: 5000 x $4 + 800 x $20 = $0.036
    expect(row.cost_microusd).toBe(31_200 + 36_000);
    expect([row.input_tokens, row.output_tokens]).toEqual([5300, 1300]);
    const result = JSON.parse(row.result_json);
    expect(result.verifiedBy).toBe("claude-opus-5-5");
    expect(result.checks).toHaveLength(1);
  });

  it("a verifier call that fails without reporting usage keeps its worst case booked, and nothing is shown", async () => {
    const silent: ModelProvider = { name: "x", model: "claude-opus-5-5", complete: async () => { throw new Error("socket hang up"); } };
    await Q.askQuestion("ws_v", vid, { id: "u_b", email: "b@example.com" }, "What are the payment terms?", answerer, null, silent);
    const row = db.one<{ c: number; result_json: string }>("SELECT cost_microusd c, result_json FROM qa_answers WHERE asked_by = 'b@example.com'")!;
    const worst = P.worstCaseMicroUsd("claude-opus-5-5", Math.ceil(A.QA_LIMITS.maxDocumentChars / 3) + 8000, V.VERIFY_LIMITS.maxOutputTokens);
    expect(row.c).toBe(31_200 + worst);
    expect(JSON.parse(row.result_json).warnings.join(" ")).toMatch(/couldn't be verified/);
  });

  it("both calls' worst cases are booked before either is made: a budget that fits one but not both falls back to passages", async () => {
    let called = 0;
    const counting: ModelProvider = { ...answerer, complete: async (r) => (called++, answerer.complete(r)) };
    const doc = Math.ceil(A.QA_LIMITS.maxDocumentChars / 3) + 4000;
    const one = P.worstCaseMicroUsd("claude-opus-5-5", doc, A.QA_LIMITS.maxOutputTokens);
    db.run("DELETE FROM qa_answers WHERE workspace_id = 'ws_v'");
    const before = process.env.AI_WORKSPACE_DAILY_BUDGET_USD;
    process.env.AI_WORKSPACE_DAILY_BUDGET_USD = String((one * 1.2) / 1e6);
    try {
      await Q.askQuestion("ws_v", vid, { id: "u_c", email: "c@example.com" }, "What are the payment terms?", counting, null, verifier(true));
      expect(called).toBe(0);
      // without the verifier, the same budget fits the one call
      await Q.askQuestion("ws_v", vid, { id: "u_c", email: "c@example.com" }, "What is the fee?", counting, null, null);
      expect(called).toBe(1);
    } finally {
      if (before === undefined) delete process.env.AI_WORKSPACE_DAILY_BUDGET_USD;
      else process.env.AI_WORKSPACE_DAILY_BUDGET_USD = before;
    }
  });
});
