// M3: the inbound webhook token is a bearer credential in a URL. Only its hash may be stored, an existing
// (legacy plaintext) URL keeps working and is re-stored as a hash on first use, and rotation stops the old URL.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-inbound-"));
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";

const LEGACY = "legacy-inbound-url-token-1";
describe("inbound token storage", () => {
  let db: typeof import("../lib/db");
  let inbound: typeof import("../lib/inbound");
  let util: typeof import("../lib/util");
  let POST: typeof import("../app/api/inbound/[token]/route").POST;
  let ip = 0;
  const call = (tok: string, body: unknown = { client_name: "Jordan Sample", client_email: `j${ip}@example.com`, ref: `R-${ip}`, send: false }) =>
    POST(new Request(`http://localhost:3000/api/inbound/${tok}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ip}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ token: tok }) });

  beforeAll(async () => {
    db = await import("../lib/db");
    inbound = await import("../lib/inbound");
    util = await import("../lib/util");
    POST = (await import("../app/api/inbound/[token]/route")).POST;
    for (const [id, tok] of [["ws_a", LEGACY], ["ws_b", "legacy-inbound-url-token-2"]])
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", id, id, id, id, "Avery Tester", "avery@example.com", tok, new Date().toISOString());
  });

  it("an existing plaintext URL still works, then is stored only as a hash", async () => {
    expect((await call(LEGACY)).status).not.toBe(404);
    expect(db.one<{ n: number }>("SELECT count(*) n FROM workspaces WHERE inbound_token = ?", LEGACY)!.n).toBe(0);
    expect(db.one<{ token_hash: string }>("SELECT token_hash FROM inbound_tokens WHERE workspace_id = 'ws_a'")!.token_hash).toBe(util.sha256(LEGACY));
    // (no agreement is published here, so a reachable URL answers 409 rather than 201)
    // and keeps working from the hash alone
    expect((await call(LEGACY)).status).not.toBe(404);
  });

  it("the stored hash (or its placeholder) is not itself a working URL token", async () => {
    const h = util.sha256(LEGACY);
    expect((await call(h)).status).toBe(404);
    expect((await call(`sha256:${h}`)).status).toBe(404);
  });

  it("unknown tokens are 404 and tokens never reach the error body", async () => {
    const r = await call("not-a-real-token-xyz");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("not-a-real-token-xyz");
  });

  it("rotation stores only a hash, stops the old URL, and leaves other workspaces alone", async () => {
    const t = inbound.rotateInboundToken("ws_a");
    expect(db.one<{ n: number }>("SELECT count(*) n FROM workspaces WHERE inbound_token = ?", t)!.n).toBe(0);
    expect(JSON.stringify(db.all("SELECT * FROM inbound_tokens"))).not.toContain(t);
    expect((await call(LEGACY)).status).toBe(404);
    expect((await call(t)).status).not.toBe(404);
    expect((await call("legacy-inbound-url-token-2")).status).not.toBe(404);
    expect(inbound.workspaceByInboundToken(t)!.id).toBe("ws_a");
  });
});
