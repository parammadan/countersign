// A stale file row (the worker holds one across awaits) must not log or announce an expiry that didn't happen.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-exp-"));
process.env.APP_URL = "http://localhost:3000";

describe("expireIfDue with a stale row", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let ws: import("../lib/types").Workspace;
  const actor = { kind: "system" as const, label: "test" };

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_exp','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_exp',?)",
      new Date().toISOString(),
    );
    ws = files.getWorkspace("ws_exp");
    const tpl = await import("../lib/templates");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
  });

  const expiredEvents = (id: string) => db.all("SELECT 1 FROM audit_events WHERE file_id = ? AND type = 'file.expired'", id).length;

  it("does not write file.expired when the file was signed after the row was read", async () => {
    const f = await files.createFile(ws, { clientName: "Taylor Mock", clientEmail: "taylor@example.com" }, actor, {});
    const stale = files.getFile(ws.id, f.id);
    db.run("UPDATE files SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), f.id);
    const staleDue = files.getFile(ws.id, f.id);
    db.run("UPDATE files SET status = 'signed' WHERE id = ?", f.id);
    const out = files.expireIfDue({ ...staleDue, status: "sent" }, ws);
    expect(out.status).toBe("signed");
    expect(expiredEvents(f.id)).toBe(0);
    void stale;
  });

  it("writes file.expired once even when called twice with the same stale row", async () => {
    const f = await files.createFile(ws, { clientName: "Casey Mock", clientEmail: "casey@example.com" }, actor, {});
    db.run("UPDATE files SET status = 'sent', expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), f.id);
    const row = files.getFile(ws.id, f.id);
    files.expireIfDue(row, ws);
    files.expireIfDue(row, ws);
    expect(files.getFile(ws.id, f.id).status).toBe("expired");
    expect(expiredEvents(f.id)).toBe(1);
  });
});
