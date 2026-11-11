// "Sign on your phone": the desktop polls /api/sign/[token]/status while the client signs on the phone. It answers
// only { status } from a small public set, by the signing page's rules (unknown link 404, expiry, the 30 days after
// completion), writes nothing (no audit event, no "viewed", no expiry update) and has its own per-IP limit.
import { describe, it, expect, beforeAll, vi } from "vitest";

// no request here, so no verification cookie: an OTP workspace treats this caller as unverified
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-signstatus-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1"; // so each test can come from its own address

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("the signing link's status route", () => {
  let mod: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let GET: typeof import("../app/api/sign/[token]/status/route").GET;
  let PDF: typeof import("../app/api/sign/[token]/pdf/route").GET;
  let ws: import("../lib/types").Workspace;
  let templateId = "";
  let n = 0;
  let ipN = 0;

  async function file(send = true) {
    const f = await mod.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: `jordan${++n}@example.com`, ref: `SS-${n}` }, { kind: "system", label: "test" }, {}, send);
    return { f, tok: new URL(mod.signingLink(f)!).pathname.split("/").pop()! };
  }
  const freshIp = () => `203.0.113.${++ipN}`;
  const status = (tok: string, ip = freshIp()) =>
    GET(new Request(`http://localhost:3000/api/sign/${tok}/status`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token: tok }) });
  async function body(tok: string) {
    const r = await status(tok);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const j = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["status"]);
    return j.status;
  }
  const trail = (fileId: string) => db.all<{ type: string }>("SELECT type FROM audit_events WHERE file_id = ? ORDER BY rowid", fileId).map((e) => e.type);

  beforeAll(async () => {
    db = await import("../lib/db");
    mod = await import("../lib/files");
    const tpl = await import("../lib/templates");
    GET = (await import("../app/api/sign/[token]/status/route")).GET;
    PDF = (await import("../app/api/sign/[token]/pdf/route")).GET;
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, auto_countersign, created_at) VALUES ('ws_ss','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_ss',0,?)",
      new Date().toISOString(),
    );
    ws = mod.getWorkspace("ws_ss");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
    templateId = r.template.id;
  });

  it("is pending while the agreement waits (draft, sent, viewed), and writes nothing", async () => {
    const { f, tok } = await file();
    const before = trail(f.id);
    expect(await body(tok)).toBe("pending");
    for (let i = 0; i < 5; i++) await body(tok);
    const after = mod.getFile(ws.id, f.id);
    expect(after.status).toBe("sent"); // no "viewed" side effect
    expect(after.viewed_at).toBeNull();
    expect(trail(f.id)).toEqual(before); // no audit event

    mod.markViewed(after, ws, {});
    expect(await body(tok)).toBe("pending");

    const d = await file(false);
    expect(mod.getFile(ws.id, d.f.id).status).toBe("draft");
    expect(await body(d.tok)).toBe("pending");
  });

  it("is signed once the client signed, then completed once countersigned", async () => {
    const { f, tok } = await file();
    await mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
    expect(await body(tok)).toBe("signed");
    await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {});
    expect(await body(tok)).toBe("completed");
  });

  it("with emailed codes on, an unverified link holder is told 'signed', not 'completed' (as the page withholds it)", async () => {
    const { f, tok } = await file();
    await mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
    await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {});
    db.run("UPDATE workspaces SET require_otp = 1 WHERE id = ?", ws.id);
    try {
      expect(await body(tok)).toBe("signed");
    } finally {
      db.run("UPDATE workspaces SET require_otp = 0 WHERE id = ?", ws.id);
    }
    expect(await body(tok)).toBe("completed");
  });

  it("is declined, voided", async () => {
    const a = await file();
    await mod.declineFile(a.tok, "Not the terms we agreed", {});
    expect(await body(a.tok)).toBe("declined");
    const b = await file();
    mod.voidFile(mod.getFile(ws.id, b.f.id), ws, { kind: "user", label: "avery@example.com" }, "Sent to the wrong client", {});
    expect(await body(b.tok)).toBe("voided");
  });

  it("is expired past the link's date (read only: the file and its trail are left to the page and worker)", async () => {
    const { f, tok } = await file();
    db.run("UPDATE files SET expires_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), f.id);
    const before = trail(f.id);
    expect(await body(tok)).toBe("expired");
    expect(mod.getFile(ws.id, f.id).status).toBe("sent");
    expect(trail(f.id)).toEqual(before);
    // and once the page (or the worker) has moved it on
    mod.expireIfDue(mod.getFile(ws.id, f.id), ws);
    expect(mod.getFile(ws.id, f.id).status).toBe("expired");
    expect(await body(tok)).toBe("expired");
  });

  it("is expired more than 30 days after completion, like the page", async () => {
    const { f, tok } = await file();
    await mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
    await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {});
    db.run("UPDATE files SET completed_at = ? WHERE id = ?", new Date(Date.now() - 29 * 86400_000).toISOString(), f.id);
    expect(await body(tok)).toBe("completed");
    db.run("UPDATE files SET completed_at = ? WHERE id = ?", new Date(Date.now() - 31 * 86400_000).toISOString(), f.id);
    expect(await body(tok)).toBe("expired");
  });

  it("is 404 with no detail for an unknown, malformed or oversized link", async () => {
    for (const tok of ["nope", "A".repeat(43), "A".repeat(101), ""]) {
      const r = await status(tok);
      expect(r.status).toBe(404);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      const j = (await r.json()) as Record<string, unknown>;
      expect(j.status).toBeUndefined();
      expect(JSON.stringify(j)).not.toMatch(/sign|link|token|expired/i);
    }
  });

  it("never carries document content, names or emails", async () => {
    const { tok } = await file();
    const r = await status(tok);
    const text = await r.text();
    expect(text).toBe('{"status":"pending"}');
  });

  it("is limited to 60 a minute per address, in its own bucket (the signing routes' limits are untouched)", async () => {
    const { tok } = await file();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await status(tok, ip)).status, `request ${i + 1}`).toBe(200);
    const r = await status(tok, ip);
    expect(r.status).toBe(429);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys((await r.json()) as object)).toEqual(["error"]);
    // another address isn't affected
    expect((await status(tok)).status).toBe(200);
    // the same address can still load the agreement's PDF (its own 60/min "signpdf" bucket)
    const pdf = await PDF(new Request(`http://localhost:3000/api/sign/${tok}/pdf`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token: tok }) });
    expect(pdf.status).toBe(200);
  });

  it("an unknown link counts toward the limit too, so it can't be used to guess links", async () => {
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await status(`guess${i}`, ip)).status).toBe(404);
    expect((await status("guess-final", ip)).status).toBe(429);
  });
});
