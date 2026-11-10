// Review of PR #44: with no email provider (outbox mode) email verification is "not required" for sending, and
// the AI gate used the same switch, so any unconfirmed sign-up got paid model answers. The AI gate now needs a
// verified workspace whatever the email mode; only the browser tests' flag, with the test key, turns it off.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";
import { TEST_KEY } from "../lib/ai/anthropic";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-qa-outbox-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
for (const k of ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_ALLOW_UNVERIFIED_FOR_TESTS", "AI_DAILY_BUDGET_USD", "AI_WORKSPACE_DAILY_BUDGET_USD", "RESEND_API_KEY", "SMTP_USER", "SMTP_PASS"])
  delete process.env[k];

describe("AI budget in outbox mode: unverified workspaces get passages", () => {
  let db: typeof import("../lib/db");
  let Q: typeof import("../lib/qa/store");
  let files: typeof import("../lib/files");
  let T: typeof import("../lib/templates");
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  const versions: Record<string, string> = {};
  let calls = 0;
  let verifies = 0;
  // the second, independent check is a paid call too
  const verifier: ModelProvider = {
    name: "fake-verifier",
    model: "claude-opus-5-5",
    complete: async (r) => {
      verifies++;
      r.onUsage?.({ inputTokens: 3000, outputTokens: 200 });
      return { claims: [] };
    },
  };
  const answers: ModelProvider = {
    name: "fake",
    model: "claude-opus-5-5",
    complete: async (r) => {
      calls++;
      r.onUsage?.({ inputTokens: 3000, outputTokens: 200 });
      const m = ((r.context ?? "") + r.document).match(/<passage id="([^"]+)"[^>]*>([^<]{20,})<\/passage>/)!;
      return { status: "answered", answer: m[2].slice(0, 60), citations: [{ passage: m[1], quote: m[2].slice(0, 60) }] };
    },
  };

  async function workspace(wsId: string, verified: boolean) {
    const t = new Date().toISOString();
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      wsId, `Firm ${wsId}`, `Firm ${wsId} LLC`, `Firm ${wsId}`, "Avery Tester", `avery-${wsId}@example.com`, `inb_${wsId}`, t,
    );
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", `u_${wsId}`, `owner-${wsId}@example.com`, "Test Owner", "x", t, verified ? t : null);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", wsId, `u_${wsId}`, "owner", t);
    versions[wsId] = (await T.ingestAgreement(files.getWorkspace(wsId), { data: pdfBytes, filename: "engagement.pdf" }, { actor: `owner-${wsId}@example.com` })).version.id;
  }
  const ask = (wsId: string, p: ModelProvider | null, q = "What are the payment terms?", v: ModelProvider | null = null) =>
    Q.askQuestion(wsId, versions[wsId], { id: `u_${wsId}`, email: `owner-${wsId}@example.com` }, q, p, null, v);
  const last = (wsId: string) => Q.recentAnswers(wsId, versions[wsId])[0].result;

  beforeAll(async () => {
    db = await import("../lib/db");
    Q = await import("../lib/qa/store");
    files = await import("../lib/files");
    T = await import("../lib/templates");
    const E = await import("../lib/email");
    const V = await import("../lib/emailverify");
    // the premise: outbox mode, where sending needs no verification (unchanged by this fix)
    expect(E.emailMode()).toBe("outbox");
    expect(V.verificationRequired()).toBe(false);
    await workspace("ws_unverified", false);
    await workspace("ws_verified", true);
    await workspace("ws_flag", false);
    await workspace("ws_none", false);
  });

  afterEach(() => {
    delete process.env.AI_ALLOW_UNVERIFIED_FOR_TESTS;
    delete process.env.ANTHROPIC_API_KEY;
    calls = 0;
    verifies = 0;
  });

  it("an unverified workspace with a provider configured makes no model call, books nothing and says why", async () => {
    await ask("ws_unverified", answers, undefined, verifier);
    const r = last("ws_unverified");
    expect(calls).toBe(0);
    expect(verifies).toBe(0);
    expect(r.mode).toBe("passages");
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/AI answers need a confirmed email address/);
    expect(Q.aiSpentToday()).toBe(0);
  });

  it("a verified workspace gets model answers", async () => {
    await ask("ws_verified", answers, undefined, verifier);
    expect(calls).toBe(1);
    expect(verifies).toBe(1);
    expect(last("ws_verified").mode).toBe("model");
  });

  it("the browser tests' flag lets an unverified workspace through, only with the test key", async () => {
    process.env.AI_ALLOW_UNVERIFIED_FOR_TESTS = "1";
    await ask("ws_flag", answers, "What does clause 1 say?");
    expect(calls).toBe(0);
    expect(last("ws_flag").mode).toBe("passages");
    process.env.ANTHROPIC_API_KEY = TEST_KEY;
    await ask("ws_flag", answers, "What does clause 2 say?");
    expect(calls).toBe(1);
    expect(last("ws_flag").mode).toBe("model");
  });

  it("the flag is honoured only as exactly '1' with the test key", () => {
    expect(Q.aiNeedsVerifiedWorkspace({})).toBe(true);
    expect(Q.aiNeedsVerifiedWorkspace({ AI_ALLOW_UNVERIFIED_FOR_TESTS: "1" })).toBe(true);
    expect(Q.aiNeedsVerifiedWorkspace({ AI_ALLOW_UNVERIFIED_FOR_TESTS: "true", ANTHROPIC_API_KEY: TEST_KEY })).toBe(true);
    expect(Q.aiNeedsVerifiedWorkspace({ AI_ALLOW_UNVERIFIED_FOR_TESTS: "1", ANTHROPIC_API_KEY: "some-real-looking-value" })).toBe(true);
    expect(Q.aiNeedsVerifiedWorkspace({ AI_ALLOW_UNVERIFIED_FOR_TESTS: "1", ANTHROPIC_API_KEY: TEST_KEY })).toBe(false);
  });

  it("with no provider, answers are passages as before, with no note about email", async () => {
    await ask("ws_none", null);
    const r = last("ws_none");
    expect(calls).toBe(0);
    expect(r.mode).toBe("passages");
    expect(r.warnings.join(" ")).not.toMatch(/email/i);
  });

  it("the ask page's mode matches the gate: an unconfirmed workspace isn't promised AI answers", () => {
    const ids = Object.keys(versions);
    const unverified = ids.find((w) => !db.one("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email_verified_at IS NOT NULL", w))!;
    const verified = ids.find((w) => w !== unverified && !!db.one("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email_verified_at IS NOT NULL", w))!;
    expect(Q.assistantMode(answers, unverified)).toEqual({ kind: "locked", model: answers.model, canConfirm: false });
    expect(Q.assistantMode(answers, verified)).toEqual({ kind: "model", model: answers.model });
    // without a workspace (and with no provider) the mode is as before
    expect(Q.assistantMode(answers)).toEqual({ kind: "model", model: answers.model });
    expect(Q.assistantMode(null, unverified)).toEqual({ kind: "passages" });
  });
});
