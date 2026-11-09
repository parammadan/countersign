// A reminder the email-confirmation gate wouldn't allow (an unconfirmed workspace, a recipient outside its team) is
// skipped quietly by the worker: no error every minute, nothing sent, nothing changed; once the owner confirms, it
// goes out on the next tick.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-worker-unverified-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.DISABLE_WORKER = "1";
// an SMTP server that refuses connections: email "can leave the server", so the gate applies; delivery fails fast
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "test@example.com";
process.env.SMTP_PASS = "test-password";

describe("worker reminders and the email-confirmation gate", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let worker: typeof import("../lib/worker");
  let fileId = "";
  const reminders = () => db.one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE file_id = ? AND kind = 'reminder'", fileId)!.n;
  const row = () => db.one<{ status: string; reminders_sent: number; last_reminder_at: string | null }>("SELECT status, reminders_sent, last_reminder_at FROM files WHERE id = ?", fileId)!;

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    worker = await import("../lib/worker");
    const tpl = await import("../lib/templates");
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_w','owner@example.com','Avery Tester','x',?)", t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at, reminder_days, expiry_days) VALUES ('ws_w','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','owner@example.com','inb_w',?, '2,5', 14)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_w','usr_w','owner',?)", t);
    const ws = files.getWorkspace("ws_w");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/01-simple-one-page.pdf"), filename: "a.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, version.id, "test");
    // sent to the owner (allowed), then the recipient is someone outside the team (as for files sent before the gate)
    const f = await files.createFile(ws, { templateId: template.id, clientName: "Avery Tester", clientEmail: "owner@example.com" }, { kind: "system", label: "test" }, {});
    fileId = f.id;
    db.run("UPDATE files SET client_email = 'jordan@example.com', sent_at = ?, expires_at = ? WHERE id = ?", new Date(Date.now() - 3 * 86400_000).toISOString(), new Date(Date.now() + 10 * 86400_000).toISOString(), fileId);
  });

  it("skips the due reminder without an error, an email or a change", async () => {
    const before = row();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await worker.tick();
      expect(r.reminded).toBe(0);
      expect(err.mock.calls.filter((c) => String(c[0]).startsWith("[worker]"))).toEqual([]);
    } finally {
      err.mockRestore();
    }
    expect(reminders()).toBe(0);
    expect(row()).toEqual(before);
  });

  it("sends it on the next tick once the owner has confirmed", async () => {
    db.run("UPDATE users SET email_verified_at = ? WHERE id = 'usr_w'", new Date().toISOString());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await worker.tick();
      expect(r.reminded).toBe(1);
    } finally {
      err.mockRestore();
    }
    expect(row().reminders_sent).toBe(1);
    expect(reminders()).toBe(1);
  });
});
