// sendOnce: one send per file and email kind at a time, and not again within the window. Concurrency is
// simulated with sends that take time and record their email at the end, like the real email service.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-sendonce-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

describe("sendOnce", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let n = 0;

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    const t = new Date().toISOString();
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_s','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_s',?)", t);
    db.run("INSERT INTO templates (id, workspace_id, name, created_at) VALUES ('tpl_s','ws_s','MSA',?)", t);
    db.run("INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at) VALUES ('tv_s','tpl_s','ws_s',1,'a.pdf','x','x','0','[]','[]','{}','published',?)", t);
    for (const f of ["file_a", "file_b"])
      db.run("INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, token_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)", f, "ws_s", "tv_s", "t", "Jordan Sample", "jordan@example.com", "sent", `h_${f}`, t);
  });

  // a send that takes `ms` and then records an email with `status`, as sendEmail does
  const fakeSend = (file: string, kind: string, status: "sent" | "failed" | "logged", ms = 150) => async () => {
    await sleep(ms);
    db.run("INSERT INTO emails (id, workspace_id, file_id, kind, to_email, subject, html, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)", `em_${++n}`, "ws_s", file, kind, "jordan@example.com", "s", "h", status, new Date().toISOString());
    return status;
  };
  const count = (file: string, kind: string) => db.all("SELECT 1 FROM emails WHERE file_id = ? AND kind = ?", file, kind).length;

  it("two simultaneous requests send once; the other is told it's in flight", async () => {
    const [a, b] = await Promise.all([
      files.sendOnce("file_a", "reminder", 60_000, fakeSend("file_a", "reminder", "sent")),
      files.sendOnce("file_a", "reminder", 60_000, fakeSend("file_a", "reminder", "sent")),
    ]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ran)).toEqual({ ran: false, reason: "in_flight" });
    expect(count("file_a", "reminder")).toBe(1);
  });

  it("a request just after a successful send is refused as recent", async () => {
    const r = await files.sendOnce("file_a", "reminder", 60_000, fakeSend("file_a", "reminder", "sent"));
    expect(r).toEqual({ ran: false, reason: "recent" });
    expect(count("file_a", "reminder")).toBe(1);
  });

  it("ten concurrent requests still send exactly once", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => files.sendOnce("file_b", "resend", 60_000, fakeSend("file_b", "resend", "logged"))));
    expect(rs.filter((r) => r.ran)).toHaveLength(1);
    expect(count("file_b", "resend")).toBe(1);
  });

  it("other files and other kinds are independent", async () => {
    const [x, y] = await Promise.all([
      files.sendOnce("file_b", "reminder", 60_000, fakeSend("file_b", "reminder", "sent")),
      files.sendOnce("file_a", "completed", 60_000, fakeSend("file_a", "completed", "sent")),
    ]);
    expect(x.ran && y.ran).toBe(true);
  });

  it("a failed send never blocks a retry", async () => {
    const first = await files.sendOnce("file_a", "resend", 60_000, fakeSend("file_a", "resend", "failed"));
    expect(first.ran).toBe(true);
    const retry = await files.sendOnce("file_a", "resend", 60_000, fakeSend("file_a", "resend", "sent"));
    expect(retry.ran).toBe(true);
    expect(db.all<{ status: string }>("SELECT status FROM emails WHERE file_id = 'file_a' AND kind = 'resend' ORDER BY created_at").map((e) => e.status)).toEqual(["failed", "sent"]);
  });

  it("the lock is released when the send throws", async () => {
    await expect(files.sendOnce("file_b", "otp", 60_000, async () => { await sleep(20); throw new Error("boom"); })).rejects.toThrow("boom");
    const after = await files.sendOnce("file_b", "otp", 60_000, fakeSend("file_b", "otp", "sent", 5));
    expect(after.ran).toBe(true);
  });
});
