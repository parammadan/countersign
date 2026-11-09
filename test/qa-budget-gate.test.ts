// AI answers are paid for from one daily budget shared by every workspace. A sign-up gets a session straight away,
// so without a gate a handful of throwaway workspaces, each under its own $3 limit, could use up the $10 for
// everyone. Only workspaces whose owner confirmed their email (the same rule as invites and outbound mail) get
// model answers; the rest get passages, said so, and nothing is booked against the budget.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-qa-gate-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_DAILY_BUDGET_USD;
delete process.env.AI_WORKSPACE_DAILY_BUDGET_USD;
// an email provider is configured (as in production), so new sign-ups must confirm their address; nothing is sent
const MAIL_KEY = "RESEND_API_KEY";
const savedMailKey = process.env[MAIL_KEY];
process.env[MAIL_KEY] = ["re", "test", "not", "a", "key"].join("_");

describe("AI budget: only verified workspaces get model answers", () => {
  let db: typeof import("../lib/db");
  let Q: typeof import("../lib/qa/store");
  let files: typeof import("../lib/files");
  let T: typeof import("../lib/templates");
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  const versions: Record<string, string> = {};
  let calls = 0;
  // a call that times out: the API never reports usage, so its worst case (about $0.53 here) stays booked
  const timesOut: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { calls++; throw new Error("socket hang up"); } };
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
  const ask = (wsId: string, p: ModelProvider, q = "What are the payment terms?") => Q.askQuestion(wsId, versions[wsId], { id: `u_${wsId}`, email: `owner-${wsId}@example.com` }, q, p, null, null);

  beforeAll(async () => {
    db = await import("../lib/db");
    Q = await import("../lib/qa/store");
    files = await import("../lib/files");
    T = await import("../lib/templates");
    for (let i = 1; i <= 5; i++) await workspace(`ws_new${i}`, false);
    await workspace("ws_real", true);
  });

  afterAll(() => {
    if (savedMailKey === undefined) delete process.env[MAIL_KEY];
    else process.env[MAIL_KEY] = savedMailKey;
  });

  it("five unverified workspaces, each asking up to its own $3 limit, get passages, make no model call and book nothing", async () => {
    const modes: string[] = [];
    const warnings: string[] = [];
    for (let i = 1; i <= 5; i++)
      for (let k = 1; k <= 5; k++) {
        await ask(`ws_new${i}`, timesOut, `What does clause ${k} say?`);
        const [h] = Q.recentAnswers(`ws_new${i}`, versions[`ws_new${i}`]);
        modes.push(h.result.mode);
        warnings.push(h.result.warnings[0] ?? "");
      }
    const spent = Q.aiSpentToday();
    expect(calls).toBe(0);
    expect(spent).toBe(0);
    expect(new Set(modes)).toEqual(new Set(["passages"]));
    for (const w of warnings) expect(w).toMatch(/Confirm your email address/);
  });

  it("so today's global budget is still there for a verified workspace", async () => {
    await ask("ws_real", answers);
    const [h] = Q.recentAnswers("ws_real", versions.ws_real);
    expect(h.result.mode).toBe("model");
  });

  it("once the owner confirms their email, the workspace gets model answers", async () => {
    db.run("UPDATE users SET email_verified_at = ? WHERE id = 'u_ws_new1'", new Date().toISOString());
    await ask("ws_new1", answers, "And the fee?");
    expect(Q.recentAnswers("ws_new1", versions.ws_new1)[0].result.mode).toBe("model");
  });
});

// Review of PR #44: one mailbox can verify many "+alias" sign-ups, so verification alone doesn't stop a handful of
// fresh workspaces from using up the global budget. Workspaces created in the last week share a smaller pool.
describe("AI budget: new workspaces share a smaller pool", () => {
  let db: typeof import("../lib/db");
  let Q: typeof import("../lib/qa/store");
  let files: typeof import("../lib/files");
  let T: typeof import("../lib/templates");
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  const versions: Record<string, string> = {};
  let calls = 0;
  const timesOut: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { calls++; throw new Error("socket hang up"); } };
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
  async function workspace(wsId: string, createdDaysAgo: number) {
    const t = new Date(Date.now() - createdDaysAgo * 86400_000).toISOString();
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      wsId, `Firm ${wsId}`, `Firm ${wsId} LLC`, `Firm ${wsId}`, "Avery Tester", `avery-${wsId}@example.com`, `inb_${wsId}`, t,
    );
    // all verified: "+alias" addresses of one inbox
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", `u_${wsId}`, `same-inbox+${wsId}@example.com`, "Test Owner", "x", t, t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", wsId, `u_${wsId}`, "owner", t);
    versions[wsId] = (await T.ingestAgreement(files.getWorkspace(wsId), { data: pdfBytes, filename: "engagement.pdf" }, { actor: `same-inbox+${wsId}@example.com` })).version.id;
  }
  const ask = (wsId: string, p: ModelProvider, q = "What are the payment terms?") => Q.askQuestion(wsId, versions[wsId], { id: `u_${wsId}`, email: `same-inbox+${wsId}@example.com` }, q, p, null, null);

  beforeAll(async () => {
    db = await import("../lib/db");
    Q = await import("../lib/qa/store");
    files = await import("../lib/files");
    T = await import("../lib/templates");
    for (let i = 1; i <= 4; i++) await workspace(`ws_alias${i}`, 0);
    await workspace("ws_established", 30);
  });

  it("four verified new workspaces with slow, large answers book no more than the new-workspace pool", async () => {
    const spentBefore = Q.aiSpentToday();
    for (let i = 1; i <= 4; i++) for (let k = 1; k <= 5; k++) await ask(`ws_alias${i}`, timesOut, `What does clause ${k} say?`);
    const added = Q.aiSpentToday() - spentBefore;
    // aiSpentToday is in micro-USD; the pool let some calls through, then refused the rest
    expect(added).toBeLessThanOrEqual(Q.aiNewWorkspaceDailyBudgetUsd() * 1e6);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(20);
    expect(Q.recentAnswers("ws_alias4", versions.ws_alias4)[0].result.warnings.join(" ")).toMatch(/new workspaces have reached today's limit|workspace has reached today's AI spending limit/);
  });

  it("an established workspace still gets model answers", async () => {
    await ask("ws_established", answers);
    expect(Q.recentAnswers("ws_established", versions.ws_established)[0].result.mode).toBe("model");
  });
});
