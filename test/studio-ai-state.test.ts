// Agreement Studio's AI state shown up front, and what a draft says after the AI step, against a real (temporary)
// database with fake providers only: no network, no paid calls, no key read (the env passed in names a dummy).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-studio-ai-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_DAILY_USD_CAP;
delete process.env.AI_ALLOW_UNVERIFIED_FOR_TESTS;

let db: typeof import("../lib/db");
let B: typeof import("../lib/ai/budget");
let D: typeof import("../lib/drafts/service");
const at = () => new Date().toISOString();
const owner = { userId: "u_ws_s", userEmail: "owner-ws_s@example.com", workspaceId: "ws_s", role: "owner" as const };
const nda = {
  kind: "nda" as const,
  parties: [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "Acme Widgets Inc" }],
  terms: { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Delaware" },
};
/** A configured server, as far as configuredProvider can tell; nothing is ever sent with it. */
const configured = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-not-a-key" };

type C = { id: string; text: string };
/** A fake model that rewrites the clauses it is given; counts its calls. */
function fake(edit: (cs: C[]) => C[]) {
  const p = {
    calls: 0,
    provider: {
      name: "fake",
      model: "claude-opus-5-5",
      complete: async (r) => {
        p.calls++;
        r.onUsage?.({ inputTokens: 1_000, outputTokens: 100 });
        return { clauses: edit(JSON.parse(r.document).clauses.map((c: C) => ({ id: c.id, text: c.text }))) };
      },
    } as ModelProvider,
  };
  return p;
}

beforeAll(async () => {
  db = await import("../lib/db");
  B = await import("../lib/ai/budget");
  D = await import("../lib/drafts/service");
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_s", "Firm S", "Firm S LLC", "Firm S", "Avery Tester", "avery-s@example.com", "inb_ws_s", at());
  db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", "u_ws_s", "owner-ws_s@example.com", "Avery Tester", "h", at(), at());
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_s", "u_ws_s", "owner", at());
});

afterEach(() => {
  db.run("UPDATE users SET email_verified_at = ?", at());
  delete process.env.AI_DAILY_USD_CAP;
  B.spentUsd();
  db.run("DELETE FROM ai_spend");
});

describe("AI state up front: aiGate's rules, no model call", () => {
  it("each reason, and the gate agrees", () => {
    const p = fake((cs) => cs);
    expect(B.aiState("ws_s", false, 0.01, {})).toEqual({ available: false, reason: "off" });
    expect(B.aiState("ws_s", true, 0.01, {})).toEqual({ available: true });
    expect(B.aiGate("qa", "ws_s", p.provider, 0.01, {}).provider).not.toBeNull();

    db.run("UPDATE users SET email_verified_at = NULL");
    expect(B.aiState("ws_s", true, 0.01, {})).toEqual({ available: false, reason: "unverified" });
    expect(B.aiGate("qa", "ws_s", p.provider, 0.01, {})).toMatchObject({ provider: null, reason: "unverified" });
    db.run("UPDATE users SET email_verified_at = ?", at());

    expect(B.aiState("ws_s", true, 0.01, { AI_DAILY_USD_CAP: "0" })).toEqual({ available: false, reason: "spend_cap" });
    expect(B.aiGate("qa", "ws_s", p.provider, 0.01, { AI_DAILY_USD_CAP: "0" })).toMatchObject({ provider: null, reason: "spend_cap" });
    expect(B.aiGate("qa", "ws_s", null, 0.01, {})).toMatchObject({ provider: null });
    expect(B.aiGate("qa", "ws_s", null, 0.01, {}).reason).toBeUndefined();
    expect(p.calls).toBe(0);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM ai_spend")!.n).toBe(0); // nothing reserved
  });

  it("Studio's state for a session: both steps, from the server's configuration", () => {
    expect(D.studioAiState(owner, {})).toEqual({ suggest: { available: false, reason: "off" }, draft: { available: false, reason: "off" } });
    expect(D.studioAiState(owner, configured)).toEqual({ suggest: { available: true }, draft: { available: true } });
    db.run("UPDATE users SET email_verified_at = NULL");
    expect(D.studioAiState(owner, configured)).toEqual({ suggest: { available: false, reason: "unverified" }, draft: { available: false, reason: "unverified" } });
    db.run("UPDATE users SET email_verified_at = ?", at());
    expect(D.studioAiState(owner, { ...configured, AI_DAILY_USD_CAP: "0" })).toEqual({ suggest: { available: false, reason: "spend_cap" }, draft: { available: false, reason: "spend_cap" } });
    // the button state is a convenience: the server still refuses at the call
  });

  it("the server-side gate is unchanged: an unconfirmed workspace still never reaches the provider", async () => {
    db.run("UPDATE users SET email_verified_at = NULL");
    const p = fake((cs) => cs);
    expect(await D.createDraft(owner, nda, p.provider)).toMatchObject({ ok: true, landing: "template_fallback", fallback: "unverified" });
    expect(await D.suggestFromDescription(owner, "An NDA between Northwind Advisory LLC and Acme Widgets Inc.", p.provider)).toEqual({ ok: false, code: "unverified" });
    expect(p.calls).toBe(0);
  });
});

describe("what the draft says after the AI step", () => {
  const swap = (id: string, from: string, to: string) => (cs: C[]) => cs.map((c) => (c.id === id ? { ...c, text: c.text.replace(from, to) } : c));

  it("an allowed swap passes the checks and lands as reworded by AI", async () => {
    const p = fake(swap("term", "starts on", "begins on"));
    const r = await D.createDraft(owner, nda, p.provider);
    expect(p.calls).toBe(1);
    expect(r).toMatchObject({ ok: true, source: "model", landing: "model", reworded: 1 });
    if (!r.ok) throw new Error("not ok");
    const g = D.getDraft(owner, r.draftId);
    if (!g.ok) throw new Error("no draft");
    expect(JSON.stringify(g.version.doc)).toContain("begins on");
  });

  it("unchanged text: the AI step ran, and the page says it found nothing to reword", async () => {
    const p = fake((cs) => cs);
    const r = await D.createDraft(owner, nda, p.provider);
    expect(p.calls).toBe(1);
    expect(r).toMatchObject({ ok: true, source: "model", landing: "model_unchanged", reworded: 0 });
    expect(r.ok && "fallback" in r).toBe(false);
    expect(D.MODEL_NOTICES.model_unchanged).toBe("AI review found nothing to reword within the template's rules, so this draft is the template with exactly your values.");
    expect(D.MODEL_NOTICES.model_unchanged).not.toMatch(/reworded by AI/);
  });

  it("free rewording is still discarded", async () => {
    const p = fake(swap("term", "starts on", "kicks off on"));
    expect(await D.createDraft(owner, nda, p.provider)).toMatchObject({ ok: true, source: "template", landing: "template_fallback", fallback: "checks", reworded: 0 });
    const q = fake((cs) => cs.map((c) => (c.id === "return" ? { ...c, text: `Please note: ${c.text}` } : c)));
    expect(await D.createDraft(owner, nda, q.provider)).toMatchObject({ ok: true, landing: "template_fallback", fallback: "checks" });
  });
});
