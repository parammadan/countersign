// A production server without APP_SECRET must refuse to start (instrumentation.ts), not fail at first use mid-request.
// And if the secret still fails at use, a send or a code check fails before it changes anything.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["NODE_ENV", "APP_SECRET", "DATA_DIR", "NEXT_PHASE", "NEXT_RUNTIME", "DISABLE_WORKER", "APP_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]])) as Record<(typeof KEYS)[number], string | undefined>;
const restoreAll = () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
};
const FAKE = ["test", "only", "not", "a", "real", "secret"].join("-");
const g = globalThis as unknown as { __csworker?: NodeJS.Timeout };

describe("boot check", () => {
  let dir = "";
  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-boot-"));
    env.DATA_DIR = dir;
    delete env.APP_SECRET;
    delete env.NEXT_PHASE;
  });
  afterEach(restoreAll);

  it("in production without APP_SECRET, it throws", async () => {
    env.NODE_ENV = "production";
    const s = await import("../lib/secret");
    expect(() => s.checkSecretAtBoot()).toThrow(/APP_SECRET/);
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(false);
  });

  it("in production with APP_SECRET set, it passes", async () => {
    env.NODE_ENV = "production";
    env.APP_SECRET = FAKE;
    const s = await import("../lib/secret");
    expect(() => s.checkSecretAtBoot()).not.toThrow();
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(false);
  });

  it("is skipped while `next build` runs, which needs no secret", async () => {
    env.NODE_ENV = "production";
    env.NEXT_PHASE = "phase-production-build";
    const s = await import("../lib/secret");
    expect(() => s.checkSecretAtBoot()).not.toThrow();
  });

  it("is skipped outside production: nothing is checked or generated", async () => {
    for (const mode of ["development", "test"]) {
      env.NODE_ENV = mode;
      vi.resetModules();
      const s = await import("../lib/secret");
      expect(() => s.checkSecretAtBoot()).not.toThrow();
    }
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(false);
  });

  it("register() refuses to start a production server without APP_SECRET, before the worker starts", async () => {
    env.NODE_ENV = "production";
    env.NEXT_RUNTIME = "nodejs";
    const before = g.__csworker;
    const { register } = await import("../instrumentation");
    await expect(register()).rejects.toThrow(/APP_SECRET/);
    expect(g.__csworker).toBe(before);
  });

  it("register() starts with APP_SECRET set", async () => {
    env.NODE_ENV = "production";
    env.NEXT_RUNTIME = "nodejs";
    env.APP_SECRET = FAKE;
    env.DISABLE_WORKER = "1";
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("a secret that fails at use changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-secretuse-"));
  const tok = "tok_file_otp";

  // the modules as a production server without APP_SECRET would load them, or as a test run normally does
  async function load(broken: boolean) {
    vi.resetModules();
    env.DATA_DIR = dir;
    env.APP_URL = "http://localhost:3000";
    delete env.APP_SECRET;
    env.NODE_ENV = broken ? "production" : "test";
    return { files: await import("../lib/files"), db: await import("../lib/db") };
  }
  const row = (db: typeof import("../lib/db"), id: string) =>
    db.one<{ status: string; sent_at: string | null; expires_at: string | null; reminders_sent: number; last_reminder_at: string | null; email_status: string | null }>(
      "SELECT status, sent_at, expires_at, reminders_sent, last_reminder_at, email_status FROM files WHERE id = ?",
      id,
    );
  const emails = (db: typeof import("../lib/db"), id: string) => db.all("SELECT 1 FROM emails WHERE file_id = ?", id).length;
  const events = (db: typeof import("../lib/db"), id: string) => db.all("SELECT 1 FROM audit_events WHERE file_id = ?", id).length;

  beforeAll(async () => {
    const { db } = await load(false);
    const s = await import("../lib/secret");
    const sha = (x: string) => crypto.createHash("sha256").update(x).digest("hex");
    const t = new Date().toISOString();
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, require_otp, created_at) VALUES ('ws_b','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_b',1,?)", t);
    db.run("INSERT INTO templates (id, workspace_id, name, created_at) VALUES ('tpl_b','ws_b','MSA',?)", t);
    db.run("INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at) VALUES ('tv_b','tpl_b','ws_b',1,'a.pdf','x','x','0','[]','[]','{}','published',?)", t);
    const ins = (id: string, status: string, sentAt: string | null, otpHash: string | null = null) =>
      db.run(
        "INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, sent_at, expires_at, reminders_sent, token_hash, token_enc, otp_hash, otp_expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, "ws_b", "tv_b", "MSA: Jordan Sample", "Jordan Sample", "jordan@example.com", status, sentAt, sentAt ? "2099-01-01T00:00:00.000Z" : null, sentAt ? 1 : 0,
        sha(`tok_${id}`), s.seal(`tok_${id}`), otpHash, otpHash ? new Date(Date.now() + 10 * 60_000).toISOString() : null, t,
      );
    ins("file_draft", "draft", null);
    ins("file_sent", "sent", "2026-01-01T00:00:00.000Z");
    ins("file_otp", "sent", "2026-01-01T00:00:00.000Z", sha("file_otp:123456")); // a code for 123456, hashed as sendOtp stores it
  });
  afterEach(restoreAll);

  for (const [id, kind] of [
    ["file_draft", "invite"],
    ["file_sent", "reminder"],
    ["file_sent", "resend"],
  ] as const) {
    it(`sendFile (${kind}, ${id.slice(5)} file) fails before marking anything sent, and emails nothing`, async () => {
      const { files, db } = await load(true);
      const ws = files.getWorkspace("ws_b");
      const before = row(db, id);
      const ev = events(db, id);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(files.sendFile(files.getFile(ws.id, id), ws, kind, { kind: "system", label: "test" }, {})).rejects.toThrow(/signing link can't be built/);
      err.mockRestore();
      expect(row(db, id)).toEqual(before);
      expect(emails(db, id)).toBe(0);
      expect(events(db, id)).toBe(ev);
    });
  }

  it("with a working secret, the same send goes out (the setup above is sound)", async () => {
    const { files, db } = await load(false);
    const ws = files.getWorkspace("ws_b");
    const r = await files.sendFile(files.getFile(ws.id, "file_draft"), ws, "invite", { kind: "system", label: "test" }, {});
    expect(r.status).toBe("sent");
    expect(r.sent_at).not.toBeNull();
    expect(emails(db, "file_draft")).toBe(1);
  });

  it("checking an emailed code fails before the try is counted or the code used up", async () => {
    const { db } = await load(true);
    const { POST } = await import("../app/api/sign/[token]/verify/route");
    const otp = () => db.one<{ otp_hash: string | null; otp_attempts: number; otp_verified_at: string | null }>("SELECT otp_hash, otp_attempts, otp_verified_at FROM files WHERE id = 'file_otp'")!;
    const before = otp();
    expect(before.otp_hash).not.toBeNull();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(new Request(`http://localhost:3000/api/sign/${tok}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }) }), {
      params: Promise.resolve({ token: tok }),
    });
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(otp()).toEqual(before);
    // and the code still works once the secret does
    const ok = await load(false);
    const ws = ok.files.getWorkspace("ws_b");
    expect(ok.files.verifyOtp(ok.files.getFile(ws.id, "file_otp"), ws, "123456", {})).toBe(true);
  });
});
