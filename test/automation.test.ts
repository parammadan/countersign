// Webhooks, reminders, expiry, decline, void and OTP: the parts that run without anyone clicking.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-auto-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
process.env.DISABLE_WORKER = "1";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Hit = { event: string; sig: string; body: string };
const hits: Hit[] = [];
let failNext = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ event: String(req.headers["x-countersign-event"]), sig: String(req.headers["x-countersign-signature"]), body });
    if (failNext > 0) {
      failNext--;
      res.writeHead(500).end();
    } else res.writeHead(200).end("ok");
  });
});

let files: typeof import("../lib/files");
let db: typeof import("../lib/db");
let worker: typeof import("../lib/worker");
let ws: import("../lib/types").Workspace;
const SECRET = "test-signing-secret";
const actor = { kind: "system" as const, label: "test" };
const tok = (f: import("../lib/types").FileRow) => new URL(files.signingLink(f)!).pathname.split("/").pop()!;
const waitFor = async (pred: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  db = await import("../lib/db");
  files = await import("../lib/files");
  worker = await import("../lib/worker");
  const tpl = await import("../lib/templates");
  db.run(
    "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at, reminder_days, expiry_days) VALUES ('ws_a','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_a',?, '2,5', 14)",
    new Date().toISOString(),
  );
  db.run("INSERT INTO webhooks (id, workspace_id, url, secret, events, created_at) VALUES ('wh_a','ws_a',?,?, '*', ?)", `http://127.0.0.1:${port}/hook`, SECRET, new Date().toISOString());
  ws = files.getWorkspace("ws_a");
  const { version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/01-simple-one-page.pdf"), filename: "a.pdf" }, { actor: "test" });
  tpl.publishVersion(ws.id, version.id, "test");
});

afterAll(() => server.close());

describe("automation", () => {
  it("delivers signed webhooks and retries failures", async () => {
    failNext = 1;
    const f = await files.createFile(ws, { clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, actor, {});
    await waitFor(() => hits.some((h) => h.event === "file.sent"));
    const h = hits.find((x) => x.event === "file.sent")!;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(h.sig)!;
    expect(v1).toBe(crypto.createHmac("sha256", SECRET).update(`${t}.${h.body}`).digest("hex"));
    expect(JSON.parse(h.body).data.id).toBe(f.id);
    // the first delivery (file.created) got a 500 and is queued for retry
    const retrying = db.all<{ status: string; attempts: number }>("SELECT status, attempts FROM webhook_deliveries WHERE event = 'file.created'");
    expect(retrying[0].status).toBe("retrying");
    db.run("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE status = 'retrying'", new Date(0).toISOString());
    await worker.tick();
    expect(db.one<{ status: string }>("SELECT status FROM webhook_deliveries WHERE event = 'file.created'")!.status).toBe("delivered");
  });

  it("sends reminders on schedule, then expires the link", async () => {
    const f = await files.createFile(ws, { clientName: "Riley Example", clientEmail: "riley@example.com" }, actor, {});
    const count = () => db.one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE file_id = ? AND kind = 'reminder'", f.id)!.n;
    await worker.tick();
    expect(count()).toBe(0);
    db.run("UPDATE files SET sent_at = ? WHERE id = ?", new Date(Date.now() - 2.1 * 86400_000).toISOString(), f.id);
    await worker.tick();
    await worker.tick(); // no double send
    expect(count()).toBe(1);
    db.run("UPDATE files SET sent_at = ? WHERE id = ?", new Date(Date.now() - 5.1 * 86400_000).toISOString(), f.id);
    await worker.tick();
    expect(count()).toBe(2);
    db.run("UPDATE files SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), f.id);
    await worker.tick();
    expect(files.getFile(ws.id, f.id).status).toBe("expired");
    await expect(files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "typed" }, {})).rejects.toThrow(/expired/);
    // the firm can reopen it
    const reopened = await files.sendFile(files.getFile(ws.id, f.id), ws, "resend", actor, {});
    expect(reopened.status).toBe("sent");
    expect(reopened.expires_at! > new Date().toISOString()).toBe(true);
  });

  it("records a decline and notifies the firm", async () => {
    const f = await files.createFile(ws, { clientName: "Casey Placeholder", clientEmail: "casey@example.com" }, actor, {});
    await files.declineFile(tok(f), "Fee schedule is wrong", { ip: "198.51.100.7" });
    const d = files.getFile(ws.id, f.id);
    expect(d.status).toBe("declined");
    expect(d.decline_reason).toBe("Fee schedule is wrong");
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE file_id = ? AND kind = 'firm_declined'", f.id)!.n).toBeGreaterThan(0);
    await expect(files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "typed" }, {})).rejects.toThrow(/no longer available|already/);
  });

  it("voided files can't be signed", async () => {
    const f = await files.createFile(ws, { clientName: "Morgan Fixture", clientEmail: "morgan@example.com" }, actor, {});
    files.voidFile(f, ws, actor, "duplicate", {});
    await expect(files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "typed" }, {})).rejects.toThrow();
    expect(() => files.voidFile(files.getFile(ws.id, f.id), ws, actor, "again", {})).toThrow(/voided/);
  });

  it("requires the emailed code when the workspace asks for it", async () => {
    db.run("UPDATE workspaces SET require_otp = 1 WHERE id = ?", ws.id);
    const w = files.getWorkspace(ws.id);
    const f = await files.createFile(w, { clientName: "Taylor Mock", clientEmail: "taylor@example.com" }, actor, {});
    await expect(files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "typed" }, {})).rejects.toThrow(/code/);
    await files.sendOtp(f, w, {});
    const html = db.one<{ html: string }>("SELECT html FROM emails WHERE file_id = ? AND kind = 'otp'", f.id)!.html;
    const code = /letter-spacing:6px">(\d{6})</.exec(html)![1];
    expect(files.verifyOtp(files.getFile(w.id, f.id), w, "000000" === code ? "111111" : "000000", {})).toBe(false);
    expect(files.verifyOtp(files.getFile(w.id, f.id), w, code, {})).toBe(true);
    const done = await files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "typed" }, {});
    expect(done.status).toBe("completed");
    db.run("UPDATE workspaces SET require_otp = 0 WHERE id = ?", ws.id);
  });

  it("holds for manual countersign when auto is off", async () => {
    db.run("UPDATE workspaces SET auto_countersign = 0 WHERE id = ?", ws.id);
    const w = files.getWorkspace(ws.id);
    const f = await files.createFile(w, { clientName: "Jamie Stub", clientEmail: "jamie@example.com" }, actor, {});
    const s = await files.completeClientSigning(tok(f), { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
    expect(s.status).toBe("signed");
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE file_id = ? AND kind = 'firm_ready'", f.id)!.n).toBeGreaterThan(0);
    const c = await files.countersign(s, w, { kind: "user", label: "avery@example.com" }, {});
    expect(c.status).toBe("completed");
    await expect(files.countersign(c, w, { kind: "user", label: "x" }, {})).rejects.toThrow();
    db.run("UPDATE workspaces SET auto_countersign = 1 WHERE id = ?", ws.id);
  });
});
