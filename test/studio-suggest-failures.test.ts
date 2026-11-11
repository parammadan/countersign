// Agreement Studio suggestions through the real Anthropic adapter with a fake client: the output room is large enough
// for a long description, and each kind of failure reaches the person as its own safe code (never provider text).
// Regression for production 2026-11-11: a long consulting description hit the 1,000-token cap exactly, the answer was
// cut off, and the person saw only "Claude didn't answer". No network, no paid calls.
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-suggest-fail-"));
process.env.APP_URL = "http://localhost:3000";
for (const k of ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_DAILY_USD_CAP", "RESEND_API_KEY", "SMTP_USER", "SMTP_PASS"]) delete process.env[k];

const owner = { userId: "u_s", userEmail: "owner@example.com", userName: "Avery Tester", workspaceId: "ws_s", role: "owner" as const };
const DESC = "Consulting agreement between Northwind Advisory LLC (consultant) and Acme Widgets Inc (client), one-time fixed fee of $20,000, Delaware law, starts January 1, 2027, 30 days notice, client owns the deliverables.";
type Req = { max_tokens: number };
/** A fake Anthropic client: `reply` gets the request and returns a Messages API response, or throws. */
const fakeClient = (reply: (req: Req) => unknown) => ({ beta: { messages: { create: async (req: Req) => reply(req) } } });
const answer = (json: unknown, stop = "end_turn", out = 900) => ({ model: "claude-opus-5-5", stop_reason: stop, content: [{ type: "text", text: JSON.stringify(json) }], usage: { input_tokens: 3000, output_tokens: out } });
const apiError = (status: number) => Object.assign(new Error(`status ${status}: request echoed here`), { status });

let svc: typeof import("../lib/drafts/service");
let A: typeof import("../lib/ai/anthropic");
let n = 0;
const suggest = (client: ReturnType<typeof fakeClient>) => svc.suggestFromDescription({ ...owner, userId: `u_s_${++n}` }, DESC, A.anthropicProvider({ model: "claude-opus-5-5", client: client as never }));

beforeAll(async () => {
  const db = await import("../lib/db");
  svc = await import("../lib/drafts/service");
  A = await import("../lib/ai/anthropic");
  const t = new Date().toISOString();
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_s", "Northwind", "Northwind Advisory LLC", "Northwind", "Avery Tester", "owner@example.com", "inb_s", t);
  db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", "u_s", "owner@example.com", "Avery Tester", "h", t, t);
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_s", "u_s", "owner", t);
});

describe("Studio suggestion: output room and failure reasons", () => {
  it("asks for enough output room for a long description (more than the 1,000 tokens that cut answers off)", async () => {
    let asked = 0;
    const r = await suggest(fakeClient((req) => { asked = req.max_tokens; return answer({ kind: "consulting", parties: [], terms: [], clarifications: [] }, "end_turn", 1_400); }));
    expect(asked).toBeGreaterThanOrEqual(3_000);
    expect(r.ok).toBe(true);
  });
  it("an answer cut off at the limit is reported as cut_off, not a generic failure", async () => {
    expect(await suggest(fakeClient(() => answer({ kind: "consu" }, "max_tokens", 3_000)))).toEqual({ ok: false, code: "cut_off" });
  });
  it("rate limits and overloads are 'busy'; auth and model errors are 'unavailable'; nothing echoes provider text", async () => {
    expect(await suggest(fakeClient(() => { throw apiError(429); }))).toEqual({ ok: false, code: "busy" });
    expect(await suggest(fakeClient(() => { throw apiError(529); }))).toEqual({ ok: false, code: "busy" });
    expect(await suggest(fakeClient(() => { throw apiError(401); }))).toEqual({ ok: false, code: "unavailable" });
    expect(await suggest(fakeClient(() => { throw apiError(404); }))).toEqual({ ok: false, code: "unavailable" });
    expect(await suggest(fakeClient(() => { throw new Error("socket hang up"); }))).toEqual({ ok: false, code: "failed" });
  });
  it("an aborted request is a timeout", async () => {
    expect(await suggest(fakeClient(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }))).toEqual({ ok: false, code: "timeout" });
  });
});
