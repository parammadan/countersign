// Questions about an agreement, against a hand-built database and a synthetic agreement from fixtures/agreements:
// workspace isolation, limits, history, model failure, and nothing from the question in the audit trail.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-qa-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

describe("questions about an agreement", () => {
  let db: typeof import("../lib/db");
  let Q: typeof import("../lib/qa/store");
  let files: typeof import("../lib/files");
  let vid = "";
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  const alice = { id: "u_alice", email: "alice@example.com" };

  function workspace(id: string) {
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id, `Firm ${id}`, `Firm ${id} LLC`, `Firm ${id}`, "Avery Tester", `avery-${id}@example.com`, `inb_${id}`, new Date().toISOString(),
    );
    // a confirmed owner: model answers are only for verified workspaces (test/qa-outbox-gate.test.ts)
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", `u_owner_${id}`, `owner-${id}@example.com`, "Test Owner", "x", t, t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", id, `u_owner_${id}`, "owner", t);
  }

  beforeAll(async () => {
    db = await import("../lib/db");
    Q = await import("../lib/qa/store");
    files = await import("../lib/files");
    const T = await import("../lib/templates");
    workspace("ws_a");
    workspace("ws_b");
    vid = (await T.ingestAgreement(files.getWorkspace("ws_a"), { data: pdfBytes, filename: "engagement.pdf" }, { actor: alice.email })).version.id;
  });

  it("without a model on the server: answers with quoted passages and stores them", async () => {
    expect(Q.assistantMode()).toEqual({ kind: "passages" });
    const before = fs.readFileSync(path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`));
    await Q.askQuestion("ws_a", vid, alice, "When are invoices due?");
    const [h] = Q.recentAnswers("ws_a", vid);
    expect(h.question).toBe("When are invoices due?");
    expect(h.result.mode).toBe("passages");
    expect(h.result.citations.length).toBeGreaterThan(0);
    for (const c of h.result.citations) expect(c.page).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`)).equals(before)).toBe(true);
  });

  it("with a model: its checked answer is stored with token usage", async () => {
    const p: ModelProvider = {
      name: "fake",
      model: "fake-1",
      complete: async (r) => {
        r.onUsage?.({ inputTokens: 1500, outputTokens: 120 });
        const m = ((r.context ?? "") + r.document).match(/<passage id="([^"]+)"[^>]*>([^<]{20,})<\/passage>/)!;
        return { status: "answered", answer: m[2].slice(0, 60), citations: [{ passage: m[1], quote: m[2].slice(0, 60) }] };
      },
    };
    await Q.askQuestion("ws_a", vid, { id: "u_bob", email: "bob@example.com" }, "What are the payment terms?", p);
    const [h] = Q.recentAnswers("ws_a", vid);
    expect(h.result).toMatchObject({ mode: "model", model: "fake-1", status: "answered" });
    expect(db.one<{ input_tokens: number; output_tokens: number }>("SELECT input_tokens, output_tokens FROM qa_answers WHERE id = ?", h.id)).toEqual({ input_tokens: 1500, output_tokens: 120 });
  });

  it("if the model fails, the passages are shown instead, and said so", async () => {
    const broken: ModelProvider = { name: "x", model: "x", complete: async () => { throw new Error("upstream 529"); } };
    await Q.askQuestion("ws_a", vid, { id: "u_carol", email: "carol@example.com" }, "What are the payment terms?", broken);
    const [h] = Q.recentAnswers("ws_a", vid);
    expect(h.result.mode).toBe("passages");
    expect(h.result.warnings[0]).toMatch(/AI assistant couldn't answer/);
  });

  it("another workspace can't ask about it or see its answers", async () => {
    await expect(Q.askQuestion("ws_b", vid, { id: "u_eve", email: "eve@example.com" }, "What is the fee?")).rejects.toThrow(files.AppError);
    expect(() => Q.recentAnswers("ws_b", vid)).toThrow(files.AppError);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = 'ws_b'")!.n).toBe(0);
  });

  it("rejects empty or oversized questions", async () => {
    await expect(Q.askQuestion("ws_a", vid, { id: "u_dan", email: "dan@example.com" }, "  ")).rejects.toThrow(/up to 500/);
    await expect(Q.askQuestion("ws_a", vid, { id: "u_dan", email: "dan@example.com" }, "x".repeat(600))).rejects.toThrow(/up to 500/);
  });

  it("limits each person per minute, and each workspace per day", async () => {
    const u = { id: "u_fast", email: "fast@example.com" };
    for (let i = 0; i < Q.QA_PER_USER_PER_MINUTE; i++) await Q.askQuestion("ws_a", vid, u, `What is clause ${i + 1} about?`);
    await expect(Q.askQuestion("ws_a", vid, u, "What is the fee?")).rejects.toThrow(/Wait a minute/);
    const n = db.one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = 'ws_a'")!.n;
    for (let i = n; i < Q.QA_DAILY.model; i++)
      db.run("INSERT INTO qa_answers (id, workspace_id, template_version_id, question, result_json, mode, asked_by, created_at) VALUES (?,?,?,?,?,?,?,?)", `qa_fill${i}`, "ws_a", vid, "q", "{}", "model", "t", new Date().toISOString());
    const model: ModelProvider = { name: "m", model: "m", complete: async () => ({}) };
    await expect(Q.askQuestion("ws_a", vid, { id: "u_g", email: "g@example.com" }, "What is the fee?", model)).rejects.toThrow(/50 questions/);
    // without a model the daily allowance is larger
    await Q.askQuestion("ws_a", vid, { id: "u_g", email: "g@example.com" }, "What is the fee?", null);
  });

  it("the audit trail records mode, status and tokens, never the question or the answer", () => {
    const events = db.all<{ data_json: string }>("SELECT data_json FROM audit_events WHERE type = 'agreement.question_asked'");
    expect(events.length).toBeGreaterThan(3);
    const text = events.map((e) => e.data_json).join("\n");
    expect(text).not.toMatch(/payment terms|invoices due|quoted terms/i);
    expect(JSON.parse(events[0].data_json)).toHaveProperty("mode");
  });

  it("a failed model call still records what it cost, and the passages are shown", async () => {
    db.run("DELETE FROM qa_answers WHERE id LIKE 'qa_fill%'"); // the daily-cap test above filled the allowance
    const failing: ModelProvider = { name: "x", model: "x", complete: async (r) => { r.onUsage?.({ inputTokens: 2100, outputTokens: 4000 }); throw new Error("cut off"); } };
    await Q.askQuestion("ws_a", vid, { id: "u_h", email: "h@example.com" }, "What are the payment terms?", failing);
    const row = db.one<{ mode: string; input_tokens: number; output_tokens: number }>("SELECT mode, input_tokens, output_tokens FROM qa_answers WHERE asked_by = 'h@example.com'")!;
    expect(row).toEqual({ mode: "model_failed", input_tokens: 2100, output_tokens: 4000 });
  });

  it("dismissed M2.1 findings aren't used in answers", async () => {
    const S = await import("../lib/understand/store");
    await S.analyzeVersion("ws_a", vid, alice.email);
    const a = S.latestAnalysis("ws_a", vid)!;
    const fee = a.result.findings.find((f) => f.category === "payment" && f.status === "stated" && f.value)!;
    S.reviewFinding("ws_a", a.id, fee.id, "dismissed", alice.email);
    await Q.askQuestion("ws_a", vid, { id: "u_i", email: "i@example.com" }, "What are the payment terms?", null);
    const [h] = Q.recentAnswers("ws_a", vid);
    expect(h.result.answer).not.toContain(`${fee.label}: ${fee.value}`);
  });

  it("an attempt that fails before answering still counts, and pending or failed attempts aren't listed", async () => {
    const before = db.one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = 'ws_a'")!.n;
    const p = path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`);
    const orig = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([orig, Buffer.from("%x")]));
    try {
      await expect(Q.askQuestion("ws_a", vid, { id: "u_j", email: "j@example.com" }, "What is the fee?", null)).rejects.toThrow(/fingerprint/);
    } finally {
      fs.writeFileSync(p, orig);
    }
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = 'ws_a'")!.n).toBe(before + 1);
    expect(Q.recentAnswers("ws_a", vid, 500).some((h) => h.askedBy === "j@example.com")).toBe(false);
  });

  it("a follow-up continues the asker's own conversation, with earlier turns as context; others can't join it", async () => {
    const seen: string[] = [];
    const p: ModelProvider = {
      name: "fake",
      model: "claude-opus-5-5",
      complete: async (r) => {
        seen.push(r.document);
        r.onUsage?.({ inputTokens: 300, outputTokens: 500, cacheWriteTokens: 4000, cacheReadTokens: 0 });
        const m = ((r.context ?? "") + r.document).match(/<passage id="([^"]+)"[^>]*>([^<]{20,})<\/passage>/)!;
        return { status: "answered", answer: m[2].slice(0, 60), citations: [{ passage: m[1], quote: m[2].slice(0, 60) }] };
      },
    };
    const kim = { id: "u_kim", email: "kim@example.com" };
    const first = await Q.askQuestion("ws_a", vid, kim, "What are the payment terms?", p);
    const second = await Q.askQuestion("ws_a", vid, kim, "And when are they due?", p, first);
    expect(seen[1]).toContain("<earlier_turns>");
    expect(seen[1]).toContain("What are the payment terms?");
    const turns = Q.conversation("ws_a", vid, first);
    expect(turns.map((t) => t.id)).toEqual([first, second]);
    expect(Q.conversations("ws_a", vid).find((t) => t.id === first)).toMatchObject({ turns: 2, firstQuestion: "What are the payment terms?" });
    // someone else, or another workspace, can't continue it
    await expect(Q.askQuestion("ws_a", vid, { id: "u_lee", email: "lee@example.com" }, "And the fee?", p, first)).rejects.toThrow(/conversation wasn't found/);
    await expect(Q.askQuestion("ws_b", vid, kim, "And the fee?", p, first)).rejects.toThrow(files.AppError);
    expect(() => Q.conversation("ws_b", vid, first)).toThrow(files.AppError);
  });

  it("records what each AI answer cost, including prompt-cache tokens", () => {
    const row = db.one<{ cost_microusd: number; cache_write_tokens: number }>("SELECT cost_microusd, cache_write_tokens FROM qa_answers WHERE asked_by = 'kim@example.com' ORDER BY rowid LIMIT 1")!;
    // 300 x $4 + 500 x $20 + 4000 x $5 per million tokens = $0.0312
    expect(row).toEqual({ cost_microusd: 31_200, cache_write_tokens: 4000 });
  });

  it("past the daily AI budget, answers fall back to passages and say why; no model call is made", async () => {
    let called = 0;
    const p: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { called++; return {}; } };
    const before = process.env.AI_DAILY_BUDGET_USD;
    process.env.AI_DAILY_BUDGET_USD = "0.05"; // already spent: 2 x $0.0312
    try {
      await Q.askQuestion("ws_a", vid, { id: "u_mo", email: "mo@example.com" }, "What are the payment terms?", p);
    } finally {
      if (before === undefined) delete process.env.AI_DAILY_BUDGET_USD;
      else process.env.AI_DAILY_BUDGET_USD = before;
    }
    expect(called).toBe(0);
    const [h] = Q.recentAnswers("ws_a", vid);
    expect(h.result.mode).toBe("passages");
    expect(h.result.warnings[0]).toMatch(/spending limit/);
    expect(Q.aiDailyBudgetUsd({})).toBe(10);
    expect(Q.aiDailyBudgetUsd({ AI_DAILY_BUDGET_USD: "abc" })).toBe(10);
  });

  it("a call that fails without reporting usage keeps its worst-case cost booked; a failure before any call books nothing", async () => {
    const { worstCaseMicroUsd } = await import("../lib/ai/pricing");
    const { QA_LIMITS } = await import("../lib/qa/answer");
    const { getTemplateVersion } = await import("../lib/templates");
    const { pages } = await Q.readAgreement("ws_a", getTemplateVersion("ws_a", vid).version);
    const worst = Q.reservation({ name: "x", model: "claude-opus-5-5", complete: async () => ({}) }, null, "What are the payment terms?", pages, []).answer;
    // never more than the cap-sized worst case
    expect(worst).toBeLessThanOrEqual(worstCaseMicroUsd("claude-opus-5-5", Math.ceil(QA_LIMITS.maxDocumentChars / 3) + 8000, QA_LIMITS.maxOutputTokens));
    const silent: ModelProvider = { name: "x", model: "claude-opus-5-5", complete: async () => { throw new Error("socket hang up"); } };
    db.run("DELETE FROM qa_answers WHERE workspace_id = 'ws_a'");
    await Q.askQuestion("ws_a", vid, { id: "u_n", email: "n@example.com" }, "What are the payment terms?", silent);
    expect(db.one<{ c: number; mode: string }>("SELECT cost_microusd c, mode FROM qa_answers WHERE asked_by = 'n@example.com'")).toEqual({ c: worst, mode: "model_failed" });
    // the stored PDF doesn't match its fingerprint: nothing is called, nothing is booked
    const p = path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`);
    const orig = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([orig, Buffer.from("%x")]));
    try {
      await expect(Q.askQuestion("ws_a", vid, { id: "u_o", email: "o@example.com" }, "What is the fee?", silent)).rejects.toThrow(/fingerprint/);
    } finally {
      fs.writeFileSync(p, orig);
    }
    expect(db.one<{ c: number }>("SELECT cost_microusd c FROM qa_answers WHERE asked_by = 'o@example.com'")).toEqual({ c: 0 });
  });

  it("one workspace can't use up the AI budget: past its own daily limit it gets passages", async () => {
    let called = 0;
    const p: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { called++; return {}; } };
    const before = process.env.AI_WORKSPACE_DAILY_BUDGET_USD;
    process.env.AI_WORKSPACE_DAILY_BUDGET_USD = "0.5"; // the booked worst case above already exceeds it
    try {
      await Q.askQuestion("ws_a", vid, { id: "u_p", email: "p@example.com" }, "What are the payment terms?", p);
    } finally {
      if (before === undefined) delete process.env.AI_WORKSPACE_DAILY_BUDGET_USD;
      else process.env.AI_WORKSPACE_DAILY_BUDGET_USD = before;
    }
    expect(called).toBe(0);
    expect(Q.recentAnswers("ws_a", vid)[0].result.warnings[0]).toMatch(/This workspace has reached today's AI spending limit/);
  });
});
