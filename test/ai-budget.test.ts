// The server-wide AI spending limit (lib/ai/budget) against a real (temporary) database, with fake providers only:
// the limit is read defensively, a reservation is refused at the limit, actual costs are booked (also for a call that
// failed or timed out), concurrent calls can't overshoot, and an unconfirmed workspace never reaches the provider.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider, ModelRequest } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ai-budget-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_DAILY_USD_CAP;
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

let B: typeof import("../lib/ai/budget");
let M: typeof import("../lib/understand/model");
let db: typeof import("../lib/db");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = (chars = 0, maxOutputTokens = 1_000): Omit<ModelRequest, "signal"> => ({ system: "", document: "x".repeat(chars), schema: { type: "object" }, maxOutputTokens });
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

beforeAll(async () => {
  db = await import("../lib/db");
  B = await import("../lib/ai/budget");
  M = await import("../lib/understand/model");
  const at = new Date().toISOString();
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_a", "Northwind", "Northwind Advisory, LLC", "Northwind", "Avery Tester", "avery@example.com", "inb_a", at);
  db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", "u_owner", "owner@example.com", "Avery Tester", "h", at, at);
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_a", "u_owner", "owner", at);
});
beforeEach(() => {
  B.spentUsd(); // creates the table
  db.run("DELETE FROM ai_spend");
});

describe("the daily limit", () => {
  it("is read defensively: unset, empty, non-numeric, non-finite or negative is the $5 default", () => {
    expect(B.dailyCapUsd({})).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "" })).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "abc" })).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "Infinity" })).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "1e400" })).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "-1" })).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: " 2.5 " })).toBe(2.5);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "0" })).toBe(0);
  });

  it("prices tokens at $4 in and $20 out per million", () => {
    expect(B.costUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(B.costUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(20);
    expect(B.costUsd({ inputTokens: -5, outputTokens: Number.NaN })).toBe(0);
  });

  it("keeps its table out of the migrations: PRAGMA user_version is unchanged", () => {
    const before = db.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
    B.spentUsd();
    B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.01 });
    expect(db.one<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(before);
  });

  it("refuses a reservation that would pass the limit, and books the actual cost in place of the estimate", () => {
    const env = { AI_DAILY_USD_CAP: "1" };
    const a = B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.6 }, env)!;
    expect(a).not.toBeNull();
    expect(B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.5 }, env)).toBeNull();
    const b = B.reserve({ feature: "m3", workspaceId: "ws_a", estimateUsd: 0.4 }, env)!; // exactly at the limit is allowed
    expect(b).not.toBeNull();
    expect(B.reserve({ feature: "m3", workspaceId: "ws_a", estimateUsd: 0.01 }, env)).toBeNull();
    B.book(a, { inputTokens: 25_000, outputTokens: 0 }); // $0.10
    close(B.spentUsd(), 0.5);
    expect(B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.5 }, env)).not.toBeNull();
    expect(B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.01 }, env)).toBeNull();
  });

  it("a limit of 0 refuses every call", () => {
    expect(B.reserve({ feature: "qa", workspaceId: "ws_a", estimateUsd: 0.000001 }, { AI_DAILY_USD_CAP: "0" })).toBeNull();
  });

  it("only the last 24 hours count", () => {
    db.run("INSERT INTO ai_spend (id, feature, workspace_id, state, reserved_usd, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)", "ais_old", "qa", "ws_a", "booked", 1, 9, new Date(Date.now() - 25 * 3600_000).toISOString());
    expect(B.spentUsd()).toBe(0);
  });
});

describe("a metered provider", () => {
  const env = { AI_DAILY_USD_CAP: "1" };

  it("books what a failed call cost", async () => {
    let calls = 0;
    const inner: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async (r) => { calls++; r.onUsage?.({ inputTokens: 100_000, outputTokens: 10_000 }); throw new Error("upstream 529"); } };
    const m = B.metered(inner, { feature: "qa", workspaceId: "ws_a" }, env);
    await expect(M.callModel(m.provider, req(), 1_000)).rejects.toThrow(M.AnalysisError);
    expect(calls).toBe(1);
    close(B.spentUsd(), 0.6); // $0.40 in + $0.20 out
    expect(db.one("SELECT state, input_tokens, output_tokens FROM ai_spend")).toEqual({ state: "booked", input_tokens: 100_000, output_tokens: 10_000 });
    expect(m.capped()).toBe(false);
  });

  it("books usage that arrives after the deadline", async () => {
    const inner: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async (r) => { await wait(60); r.onUsage?.({ inputTokens: 50_000, outputTokens: 5_000 }); return {}; } };
    const m = B.metered(inner, { feature: "studio_draft", workspaceId: "ws_a" }, env);
    await expect(M.callModel(m.provider, req(), 10)).rejects.toThrow(/too long/);
    await wait(100);
    close(B.spentUsd(), 0.3);
    expect(db.one<{ state: string }>("SELECT state FROM ai_spend")!.state).toBe("booked");
  });

  it("keeps the estimate for a call stopped at the deadline without usage, and releases one the API refused outright", async () => {
    const hung: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: (r) => new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted")))) };
    await expect(M.callModel(B.metered(hung, { feature: "m3", workspaceId: "ws_a" }, env).provider, req(2_000, 1_000), 10)).rejects.toThrow(/too long/);
    await wait(10);
    close(B.spentUsd(), B.estimateUsd(2_000, 1_000));
    db.run("DELETE FROM ai_spend");
    const down: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); } };
    await expect(M.callModel(B.metered(down, { feature: "m3", workspaceId: "ws_a" }, env).provider, req(), 1_000)).rejects.toThrow(M.AnalysisError);
    expect(B.spentUsd()).toBe(0);
    expect(db.one<{ state: string }>("SELECT state FROM ai_spend")!.state).toBe("released");
  });

  it("an answer that reports no usage is charged its estimate", async () => {
    const silent: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => ({}) };
    await M.callModel(B.metered(silent, { feature: "qa", workspaceId: "ws_a" }, env).provider, req(1_000, 500), 1_000);
    close(B.spentUsd(), B.estimateUsd(1_000, 500));
  });

  it("concurrent calls can't overshoot the limit: the ones that don't fit never reach the provider", async () => {
    let calls = 0;
    // each call is reserved at about $0.30 and costs exactly that
    const est = B.estimateUsd(5_000, 14_000);
    const tokens = Math.round((est * 1_000_000) / 20);
    const inner: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async (r) => { calls++; await wait(30); r.onUsage?.({ inputTokens: 0, outputTokens: tokens }); return {}; } };
    const m = B.metered(inner, { feature: "qa", workspaceId: "ws_a" }, env);
    const out = await Promise.allSettled(Array.from({ length: 10 }, () => M.callModel(m.provider, req(5_000, 14_000), 1_000)));
    const fits = Math.floor(1 / est);
    expect(calls).toBe(fits);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(fits);
    expect(m.capped()).toBe(true);
    expect(B.spentUsd()).toBeLessThanOrEqual(1);
  });
});

describe("only confirmed workspaces use AI", () => {
  it("an unconfirmed workspace never reaches the provider, and is told why; once confirmed it does", async () => {
    let calls = 0;
    const counting: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { calls++; return {}; } };
    process.env.SMTP_USER = "test@example.com";
    process.env.SMTP_PASS = "pw"; // dummy: email "can leave the server", so confirmation is required
    db.run("UPDATE users SET email_verified_at = NULL WHERE id = 'u_owner'");
    try {
      const g = B.aiGate("qa", "ws_a", counting, 0.01);
      expect(g).toMatchObject({ provider: null, reason: "unverified", notice: B.MESSAGES.unverified });
      expect(calls).toBe(0);
      db.run("UPDATE users SET email_verified_at = ? WHERE id = 'u_owner'", new Date().toISOString());
      const ok = B.aiGate("qa", "ws_a", counting, 0.01);
      expect(ok.provider).not.toBeNull();
      await M.callModel(ok.provider!, req(), 1_000);
      expect(calls).toBe(1);
    } finally {
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      db.run("UPDATE users SET email_verified_at = ? WHERE id = 'u_owner'", new Date().toISOString());
    }
  });

  it("with no provider configured nothing changes, and a spent allowance is AI-off with a notice", () => {
    expect(B.aiGate("qa", "ws_a", null, 0.01)).toMatchObject({ provider: null });
    expect(B.aiGate("qa", "ws_a", null, 0.01).notice).toBeUndefined();
    const counting: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => ({}) };
    expect(B.aiGate("qa", "ws_a", counting, 0.01, { AI_DAILY_USD_CAP: "0" })).toMatchObject({ provider: null, reason: "spend_cap", notice: B.MESSAGES.spendCap });
  });
});
