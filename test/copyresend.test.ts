// Re-sending the signed copy when its email failed: the sealed PDF goes out byte for byte, is never
// regenerated, and a failure is recorded as a failure. Real SMTP is configured but refuses connections.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-copy-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "test@example.com";
process.env.SMTP_PASS = "test-password";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("resend signed copy", () => {
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let ws: import("../lib/types").Workspace;
  let templateId: string;
  const actor = { kind: "user" as const, label: "avery@example.com" };
  const blob = (p: string) => path.join(dir, "blobs", p);

  async function completedFile(ref: string) {
    const f = await files.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: "jordan@example.com", ref }, actor, {});
    const tok = new URL(files.signingLink(f)!).pathname.split("/").pop()!;
    const { fields } = files.loadByToken(tok)!;
    const values: Record<string, string> = {};
    for (const x of fields) if (x.role === "client" && x.type !== "signature" && x.type !== "initials" && x.type !== "checkbox" && x.type !== "date") values[x.id] = "Test entry";
    return files.completeClientSigning(tok, { consent: true, values, signature: PNG, initials: PNG, method: "drawn" }, {});
  }

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at) VALUES ('usr_a','avery@example.com','Avery Tester','x',?,?)", t, t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_c','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_c',?)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_c','usr_a','owner',?)", t);
    ws = files.getWorkspace("ws_c");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, version.id, "test");
    templateId = template.id;
  });

  it("a failed copy email stays failed, and a resend re-sends the same sealed bytes", async () => {
    const f = await completedFile("CR-1");
    expect(f.status).toBe("completed");
    expect(f.copy_emailed_at).toBeNull();
    const doc = files.finalDocument(f)!;
    const before = fs.readFileSync(blob(doc.path));
    const emailsBefore = db.all<{ kind: string; status: string }>("SELECT kind, status FROM emails WHERE file_id = ? AND kind = 'completed'", f.id);
    expect(emailsBefore).toEqual([{ kind: "completed", status: "failed" }]);

    const r = await files.resendSignedCopy(f, ws, actor, {});
    expect(r.delivered).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.file.copy_emailed_at).toBeNull(); // never marked emailed when it wasn't
    const emailsAfter = db.all<{ status: string }>("SELECT status FROM emails WHERE file_id = ? AND kind = 'completed' ORDER BY created_at", f.id);
    expect(emailsAfter.map((e) => e.status)).toEqual(["failed", "failed"]);
    // (the invitation failed too, since this server can't send anything; only the copy's failures are counted)
    const failures = db
      .all<{ data_json: string; actor: string }>("SELECT data_json, actor FROM audit_events WHERE file_id = ? AND type = 'file.email_failed' ORDER BY seq", f.id)
      .filter((e) => JSON.parse(e.data_json).kind === "completed");
    expect(failures).toHaveLength(2);
    expect(failures[1].actor).toBe("avery@example.com");
    expect(JSON.parse(failures[1].data_json).kind).toBe("completed");
    expect(db.all("SELECT 1 FROM audit_events WHERE file_id = ? AND type = 'file.copy_resent'", f.id)).toHaveLength(0);

    // the sealed PDF and its record are untouched
    const after = files.finalDocument(files.getFile(ws.id, f.id))!;
    expect(after.sha256).toBe(doc.sha256);
    expect(Buffer.compare(fs.readFileSync(blob(after.path)), before)).toBe(0);
    expect(db.all("SELECT 1 FROM documents WHERE file_id = ? AND kind = 'final'", f.id)).toHaveLength(1);
    expect((await files.readiness(files.getFile(ws.id, f.id))).ready).toBe(true);
  });

  it("refuses files that aren't completed, and a sealed PDF that no longer matches its fingerprint", async () => {
    const open = await files.createFile(ws, { templateId, clientName: "Riley Example", clientEmail: "riley@example.com", ref: "CR-2" }, actor, {});
    await expect(files.resendSignedCopy(open, ws, actor, {})).rejects.toThrow(/Only completed files/);

    const f = await completedFile("CR-3");
    const doc = files.finalDocument(f)!;
    const good = fs.readFileSync(blob(doc.path));
    const n = db.all("SELECT 1 FROM emails WHERE file_id = ?", f.id).length;
    fs.writeFileSync(blob(doc.path), Buffer.concat([good, Buffer.from("tampered")]));
    await expect(files.resendSignedCopy(f, ws, actor, {})).rejects.toThrow(/fingerprint/);
    expect(db.all("SELECT 1 FROM emails WHERE file_id = ?", f.id)).toHaveLength(n); // nothing was sent
    fs.writeFileSync(blob(doc.path), good);
  });

  it("recentlySent counts emails that went out or were logged, never failed ones, and only for that file and kind", () => {
    const t = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const add = (file: string, kind: string, status: string, msAgo: number) =>
      db.run("INSERT INTO emails (id, workspace_id, file_id, kind, to_email, subject, html, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)", `em_${Math.random()}`, ws.id, file, kind, "x@example.com", "s", "h", status, t(msAgo));
    db.run("INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, token_hash, created_at) SELECT 'file_g1', workspace_id, template_version_id, 't', 'n', 'e@example.com', 'sent', 'hg1', ? FROM files WHERE workspace_id = 'ws_c' LIMIT 1", t(0));
    db.run("INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, token_hash, created_at) SELECT 'file_g2', workspace_id, template_version_id, 't', 'n', 'e@example.com', 'sent', 'hg2', ? FROM files WHERE workspace_id = 'ws_c' LIMIT 1", t(0));
    add("file_g1", "reminder", "failed", 5_000);
    expect(files.recentlySent("file_g1", "reminder", 60_000)).toBe(false);
    add("file_g1", "reminder", "sent", 90_000);
    expect(files.recentlySent("file_g1", "reminder", 60_000)).toBe(false); // too long ago
    add("file_g1", "reminder", "sent", 10_000);
    expect(files.recentlySent("file_g1", "reminder", 60_000)).toBe(true);
    expect(files.recentlySent("file_g1", "resend", 60_000)).toBe(false); // other kind
    expect(files.recentlySent("file_g2", "reminder", 60_000)).toBe(false); // other file
    add("file_g2", "resend", "logged", 1_000);
    expect(files.recentlySent("file_g2", "resend", 60_000)).toBe(true);
  });
});
