// Real email configured but failing, and the sign-up verification gate that only applies when email can leave the server.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-delivery-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
// an SMTP server that refuses connections: delivery is attempted and fails fast
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "test@example.com";
process.env.SMTP_PASS = "test-password";

describe("email delivery and verification", () => {
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let ev: typeof import("../lib/emailverify");
  let ws: import("../lib/types").Workspace;
  let templateId: string;
  const actor = { kind: "system" as const, label: "test" };

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    ev = await import("../lib/emailverify");
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_o','owner@example.com','Avery Tester','x',?)", t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_d','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','owner@example.com','inb_d',?)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_d','usr_o','owner',?)", t);
    ws = files.getWorkspace("ws_d");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, version.id, "test");
    templateId = template.id;
  });

  it("an unverified workspace can only send to its own team", async () => {
    expect(ev.verificationRequired()).toBe(true);
    expect(ev.workspaceVerified(ws.id)).toBe(false);
    await expect(files.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, actor, {})).rejects.toThrow(/Confirm your email/);
    expect(db.one("SELECT 1 FROM files WHERE client_email = 'jordan@example.com'")).toBeUndefined();
    // sending to yourself is allowed (Send a test to me)
    const self = await files.createFile(ws, { templateId, clientName: "Avery Tester", clientEmail: "owner@example.com" }, actor, {});
    expect(self.status).toBe("sent");
  });

  it("confirming the email lifts the gate, once, and bad tokens fail", async () => {
    await ev.sendVerification({ id: "usr_o", email: "owner@example.com", name: "Avery Tester" }, ws.id);
    const stored = db.one<{ html: string }>("SELECT html FROM emails WHERE kind = 'verify_email'")!;
    expect(stored.html).not.toContain("/confirm-email/"); // link withheld from the log
    expect(ev.confirmEmail("not-a-token").ok).toBe(false);
    // the token is only known to the recipient; issue a known one for the test
    const { sha256 } = await import("../lib/util");
    db.run("INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at) VALUES (?, 'usr_o', ?, ?)", sha256("known-token"), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    db.run("INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at) VALUES (?, 'usr_o', ?, ?)", sha256("old-token"), new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
    expect(ev.confirmEmail("old-token").ok).toBe(false);
    expect(ev.confirmEmail("known-token").ok).toBe(true);
    expect(ev.workspaceVerified(ws.id)).toBe(true);
  });

  it("a failed email is recorded as failed, not as sent", async () => {
    const f = await files.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, actor, {});
    expect(f.status).toBe("sent"); // the link is live; the firm can copy it
    expect(f.email_status).toBe("failed");
    expect(f.email_error).toBeTruthy();
    const types = db.all<{ type: string }>("SELECT type FROM audit_events WHERE file_id = ?", f.id).map((e) => e.type);
    expect(types).toContain("file.email_failed");
    expect(types).not.toContain("file.sent");
    const mail = db.one<{ status: string; html: string }>("SELECT status, html FROM emails WHERE file_id = ?", f.id)!;
    expect(mail.status).toBe("failed");
    expect(mail.html).not.toContain(new URL(files.signingLink(f)!).pathname);
    expect(files.fileJson(f).email.status).toBe("failed");
  });
});
