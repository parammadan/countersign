// "Send a new code" in the signing room uses the same code route, whose server-side limits hold: 5 codes a minute
// per address and 5 an hour per file (from any address). A refused request issues no new code and keeps the
// attempt count, so asking again can't reset the 5-try limit.
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-otp-resend-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";

describe("resending the emailed code", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let POST: typeof import("../app/api/sign/[token]/otp/route").POST;
  let ws: import("../lib/types").Workspace;
  let n = 0;
  async function file() {
    const f = await files.createFile(ws, { clientName: "Taylor Mock", clientEmail: `taylor${++n}@example.com` }, { kind: "system", label: "test" }, {});
    return { id: f.id, tok: new URL(files.signingLink(f)!).pathname.split("/").pop()! };
  }
  const send = (tok: string, ip: string) =>
    POST(new Request(`http://localhost:3000/api/sign/${tok}/otp`, { method: "POST", headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ token: tok }) });
  const row = (id: string) => db.one<{ otp_hash: string; otp_attempts: number }>("SELECT otp_hash, otp_attempts FROM files WHERE id = ?", id)!;

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    ({ POST } = await import("../app/api/sign/[token]/otp/route"));
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, require_otp, created_at) VALUES ('ws_or','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_or',1,?)",
      new Date().toISOString(),
    );
    ws = files.getWorkspace("ws_or");
    const tpl = await import("../lib/templates");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
  });

  it("5 codes an hour per file, even from different addresses; the 6th is refused and changes nothing", async () => {
    const { id, tok } = await file();
    for (let i = 1; i <= 5; i++) expect((await send(tok, `198.51.100.${i}`)).status, `code ${i}`).toBe(200);
    db.run("UPDATE files SET otp_attempts = 3 WHERE id = ?", id);
    const before = row(id);
    const r = await send(tok, "198.51.100.99");
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toBe("Too many codes requested. Try again in an hour.");
    expect(row(id)).toEqual(before);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE file_id = ? AND kind = 'otp'", id)!.n).toBe(5);
  });

  it("5 code requests a minute per address, across files", async () => {
    const ip = "203.0.113.7";
    const fs6 = [];
    for (let i = 0; i < 6; i++) fs6.push(await file());
    for (let i = 0; i < 5; i++) expect((await send(fs6[i].tok, ip)).status).toBe(200);
    const r = await send(fs6[5].tok, ip);
    expect(r.status).toBe(429);
    expect(row(fs6[5].id).otp_hash).toBeNull();
  });

  it("the signing room offers Send a new code after the first one, through the same route", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/SigningRoom.tsx"), "utf8");
    expect(src).toContain("fetch(`/api/sign/${token}/otp`, { method: \"POST\" })");
    expect(src).toContain('"Send a new code"');
    expect(src).toContain("{EMAIL_HELP.otp}");
  });
});
