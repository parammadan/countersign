// Review of #68: one confirmed-email rule and one set of spending limits for every AI feature (Q&A, Studio,
// Knowledge Hub), whatever the email mode; and a failed call is released only when it can't have been billed.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-limits-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
const ENV = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_DAILY_USD_CAP", "AI_DAILY_BUDGET_USD", "AI_WORKSPACE_DAILY_BUDGET_USD", "AI_NEW_WORKSPACE_DAILY_BUDGET_USD", "RESEND_API_KEY", "SMTP_USER", "SMTP_PASS", "AI_ALLOW_UNVERIFIED_FOR_TESTS"];
for (const k of ENV) delete process.env[k];

let db: typeof import("../lib/db");
let B: typeof import("../lib/ai/budget");
let D: typeof import("../lib/drafts/service");
let Q: typeof import("../lib/qa/store");
let files: typeof import("../lib/files");
let T: typeof import("../lib/templates");
const at = () => new Date().toISOString();
const OLD = "2020-01-01T00:00:00.000Z";

function counting(fail?: unknown) {
  const p = {
    calls: 0,
    provider: {
      name: "fake",
      model: "claude-opus-5-5",
      complete: async (r) => {
        p.calls++;
        if (fail) throw fail;
        r.onUsage?.({ inputTokens: 3000, outputTokens: 200 });
        const m = ((r.context ?? "") + r.document).match(/<passage id="([^"]+)"[^>]*>([^<]{20,})<\/passage>/);
        return m ? { status: "answered", answer: m[2].slice(0, 60), citations: [{ passage: m[1], quote: m[2].slice(0, 60) }] } : { nonsense: true };
      },
    } as ModelProvider,
  };
  return p;
}
function workspace(id: string, verified: boolean, createdAt = OLD) {
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", id, `Firm ${id}`, `Firm ${id} LLC`, "F", "A", `${id}@example.com`, `inb_${id}`, createdAt);
  db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", `u_${id}`, `o-${id}@example.com`, "O", "h", at(), verified ? at() : null);
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", id, `u_${id}`, "owner", at());
}
const nda = () => ({ kind: "nda" as const, parties: [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "Acme Widgets Inc" }], terms: { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Delaware" } });
const owner = (ws: string) => ({ userId: `u_${ws}`, userEmail: `o-${ws}@example.com`, workspaceId: ws, role: "owner" as const });
const book = (ws: string, usd: number) => db.run("INSERT INTO ai_spend (id, feature, workspace_id, state, reserved_usd, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)", `x_${Math.random()}`, "studio_draft", ws, "booked", usd, usd, at());
async function agreement(ws: string) {
  const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  return (await T.ingestAgreement(files.getWorkspace(ws), { data: pdf, filename: "e.pdf" }, { actor: `o-${ws}@example.com` })).version.id;
}

beforeAll(async () => {
  db = await import("../lib/db");
  B = await import("../lib/ai/budget");
  D = await import("../lib/drafts/service");
  Q = await import("../lib/qa/store");
  files = await import("../lib/files");
  T = await import("../lib/templates");
  workspace("ws_u", false);
  workspace("ws_v", true);
  workspace("ws_w", true);
  workspace("ws_n", true, at()); // created now: in the new-workspace pool
  B.spentUsd(); // creates ai_spend
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  db.run("DELETE FROM ai_spend");
  db.run("DELETE FROM qa_answers");
});

describe("an unconfirmed workspace gets no AI in any feature, also with no email provider (outbox)", () => {
  it("Q&A, Studio and the Knowledge Hub never reach the provider", async () => {
    const qa = counting();
    await Q.askQuestion("ws_u", await agreement("ws_u"), { id: "u_ws_u", email: "o-ws_u@example.com" }, "What are the payment terms?", qa.provider, null, null);
    const st = counting();
    const r = await D.createDraft(owner("ws_u"), nda(), st.provider);
    const g = B.aiGate("m3", "ws_u", st.provider, 0.01);
    expect(qa.calls + st.calls).toBe(0);
    expect(r.ok && r.fallback).toBe("unverified");
    expect(g.provider).toBeNull();
    expect(g.reason).toBe("unverified");
  });
});

describe("one daily limit", () => {
  it("either variable limits every feature; with both, the lower wins", () => {
    expect(B.dailyCapUsd({})).toBe(5);
    expect(B.dailyCapUsd({ AI_DAILY_BUDGET_USD: "2" })).toBe(2);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "7" })).toBe(7);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "7", AI_DAILY_BUDGET_USD: "3" })).toBe(3);
    expect(B.dailyCapUsd({ AI_DAILY_USD_CAP: "abc", AI_DAILY_BUDGET_USD: "-1" })).toBe(5);
    expect(Q.aiDailyBudgetUsd).toBe(B.dailyCapUsd);
  });
  it("past the limit through Studio spend, Q&A doesn't call the model either", async () => {
    book("ws_w", 6); // another workspace spent $6 through Studio: over the $5 default
    const qa = counting();
    await Q.askQuestion("ws_v", await agreement("ws_v"), { id: "u_ws_v", email: "o-ws_v@example.com" }, "What are the payment terms?", qa.provider, null, null);
    expect(qa.calls).toBe(0);
    expect(B.aiGate("m3", "ws_v", qa.provider, 0.01).reason).toBe("spend_cap");
  });
  it("a workspace's own limit covers Studio and the Knowledge Hub too", () => {
    process.env.AI_WORKSPACE_DAILY_BUDGET_USD = "1";
    book("ws_v", 0.99);
    expect(B.aiGate("m3", "ws_v", counting().provider, 0.05).reason).toBe("spend_cap");
    expect(B.aiGate("m3", "ws_w", counting().provider, 0.05).provider).not.toBeNull();
    expect(B.reserve({ feature: "studio_draft", workspaceId: "ws_v", estimateUsd: 0.05 })).toBeNull();
  });
  it("new workspaces share the smaller pool across features", () => {
    process.env.AI_NEW_WORKSPACE_DAILY_BUDGET_USD = "0.5";
    book("ws_n", 0.49);
    expect(B.reserve({ feature: "m3", workspaceId: "ws_n", estimateUsd: 0.05 })).toBeNull();
    expect(B.reserve({ feature: "m3", workspaceId: "ws_v", estimateUsd: 0.05 })).not.toBeNull();
  });
});

describe("a failed call is released only when it can't have been billed", () => {
  const run = async (err: unknown) => {
    const m = B.metered(counting(err).provider, { feature: "m3", workspaceId: "ws_v" });
    await m.provider.complete({ system: "s", document: "d", schema: {}, maxOutputTokens: 100, signal: new AbortController().signal }).catch(() => {});
    return B.spentUsd();
  };
  it("a 4xx refusal is released", async () => {
    expect(await run(Object.assign(new Error("bad request"), { status: 400 }))).toBe(0);
  });
  it("a lost connection or a 5xx keeps its reservation as its cost", async () => {
    expect(await run(new Error("socket hang up"))).toBeGreaterThan(0);
    db.run("DELETE FROM ai_spend");
    expect(await run(Object.assign(new Error("overloaded"), { status: 529 }))).toBeGreaterThan(0);
  });
});
