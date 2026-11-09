// Emailed codes allow 5 tries. The verify route loads the file, then awaits the request body, then checks the code,
// so the attempt count it holds can be stale; the limit has to be taken from the row itself, atomically, or
// concurrent requests (from different addresses, past the per-IP limit) each see "0 tries so far".
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-otp-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1"; // so each request below comes from its own address

describe("emailed codes: the 5-try limit holds against stale reads and concurrent requests", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let ws: import("../lib/types").Workspace;
  let n = 0;
  const actor = { kind: "system" as const, label: "test" };

  /** A sent file with a fresh code; returns the file, its signing token and the code (recovered from its hash). */
  async function withCode() {
    const f = await files.createFile(ws, { clientName: "Taylor Mock", clientEmail: `taylor${++n}@example.com` }, actor, {});
    await files.sendOtp(f, ws, {});
    const row = files.getFile(ws.id, f.id);
    let code = "";
    for (let i = 100000; i < 1000000 && !code; i++) if (crypto.createHash("sha256").update(`${f.id}:${i}`).digest("hex") === row.otp_hash) code = String(i);
    const tok = new URL(files.signingLink(f)!).pathname.split("/").pop()!;
    return { f: row, tok, code, wrong: code === "123456" ? "654321" : "123456" };
  }
  const attempts = (id: string) => db.one<{ n: number }>("SELECT otp_attempts n FROM files WHERE id = ?", id)!.n;

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, require_otp, created_at) VALUES ('ws_otp','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_otp',1,?)",
      new Date().toISOString(),
    );
    ws = files.getWorkspace("ws_otp");
    const tpl = await import("../lib/templates");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
  });

  it("six calls with the same stale file object: five wrong codes are counted and the sixth (the right code) is refused", async () => {
    const { f, code, wrong } = await withCode();
    for (let i = 0; i < 5; i++) expect(files.verifyOtp(f, ws, wrong, {})).toBe(false);
    expect(attempts(f.id)).toBe(5);
    expect(() => files.verifyOtp(f, ws, code, {})).toThrow(/Too many wrong codes/);
    expect(files.getFile(ws.id, f.id).otp_verified_at).toBeNull();
  });

  it("concurrent requests to the verify route can't each use the stale count", async () => {
    const { POST } = await import("../app/api/sign/[token]/verify/route");
    const { f, tok, code, wrong } = await withCode();
    const req = (c: string, i: number) =>
      POST(new Request(`http://localhost:3000/api/sign/${tok}/verify`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i}` }, body: JSON.stringify({ code: c }) }), {
        params: Promise.resolve({ token: tok }),
      });
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => req(wrong, i + 1)));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 400)).toHaveLength(5); // wrong code, counted
    expect(statuses.filter((s) => s === 429)).toHaveLength(15); // over the limit
    expect(attempts(f.id)).toBe(5);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE file_id = ? AND type = 'file.otp_failed'", f.id)!.n).toBe(5);
    // and the right code is now refused until a new one is sent
    expect((await req(code, 99)).status).toBe(429);
  });

  it("the right code within the limit still works, once", async () => {
    const { f, code, wrong } = await withCode();
    for (let i = 0; i < 4; i++) expect(files.verifyOtp(files.getFile(ws.id, f.id), ws, wrong, {})).toBe(false);
    expect(files.verifyOtp(f, ws, code, {})).toBe(true);
    expect(files.getFile(ws.id, f.id).otp_verified_at).not.toBeNull();
    // the same stale object can't use the code again
    expect(() => files.verifyOtp(f, ws, code, {})).toThrow(/expired|new one/);
  });
});
