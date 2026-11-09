// The security fixes together (PRs #46 fingerprints, #47 signing-link PDF policy, #49 OTP attempts, #50 secret): each
// is tested on its own branch; these check how they combine on one main.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-secint-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const blob = (rel: string) => path.join(dir, "blobs", rel);
async function tampered<T>(rel: string, fn: () => Promise<T>): Promise<T> {
  const orig = fs.readFileSync(blob(rel));
  fs.writeFileSync(blob(rel), Buffer.concat([orig, Buffer.from("%x")]));
  try {
    return await fn();
  } finally {
    fs.writeFileSync(blob(rel), orig);
  }
}

describe("security fixes combined", () => {
  let mod: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let pdfGET: typeof import("../app/api/sign/[token]/pdf/route").GET;
  let verifyPOST: typeof import("../app/api/sign/[token]/verify/route").POST;
  let ws: import("../lib/types").Workspace;
  let version: import("../lib/types").TemplateVersion;
  let templateId = "";
  let n = 0;

  async function file(send = true) {
    const f = await mod.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: `jordan${++n}@example.com`, ref: `SI-${n}` }, { kind: "system", label: "test" }, {}, send);
    return { f, tok: new URL(mod.signingLink(f)!).pathname.split("/").pop()! };
  }
  const pdf = (tok: string) => pdfGET(new Request(`http://localhost:3000/api/sign/${tok}/pdf`), { params: Promise.resolve({ token: tok }) });
  const mismatches = (fileId: string) => db.all("SELECT 1 FROM audit_events WHERE type = 'document.fingerprint_mismatch' AND file_id = ?", fileId).length;

  beforeAll(async () => {
    db = await import("../lib/db");
    mod = await import("../lib/files");
    const tpl = await import("../lib/templates");
    pdfGET = (await import("../app/api/sign/[token]/pdf/route")).GET;
    verifyPOST = (await import("../app/api/sign/[token]/verify/route")).POST;
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, auto_countersign, created_at) VALUES ('ws_si','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_si',0,?)",
      new Date().toISOString(),
    );
    ws = mod.getWorkspace("ws_si");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
    templateId = r.template.id;
    version = mod.getVersion(r.version.id);
  });

  it("a declined link stays closed (410) even when the original was tampered: no hash work, no mismatch event", async () => {
    const { f, tok } = await file();
    await mod.declineFile(tok, "Not the terms we agreed", {});
    const res = await tampered(version.pdf_path, () => pdf(tok));
    expect(res.status).toBe(410);
    expect(mismatches(f.id)).toBe(0);
  });

  it("an expired link stays closed (410) with a tampered original", async () => {
    const { f, tok } = await file();
    db.run("UPDATE files SET expires_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), f.id);
    const res = await tampered(version.pdf_path, () => pdf(tok));
    expect(res.status).toBe(410);
    expect(mismatches(f.id)).toBe(0);
  });

  it("a live (sent) link with a tampered original is refused (409) and audited; intact again it's served", async () => {
    const { f, tok } = await file();
    expect((await tampered(version.pdf_path, () => pdf(tok))).status).toBe(409);
    expect(mismatches(f.id)).toBe(1);
    expect((await pdf(tok)).status).toBe(200);
  });

  it("a voided link is closed before anything else", async () => {
    const { f, tok } = await file();
    mod.voidFile(mod.getFile(ws.id, f.id), ws, { kind: "system", label: "test" }, "test", {});
    expect((await tampered(version.pdf_path, () => pdf(tok))).status).toBe(410);
  });

  it("OTP: concurrent wrong guesses are capped at five, then even the right code is refused", async () => {
    const { f, tok } = await file();
    // a code is issued as sendOtp does (it isn't returned, so it's set here the same way)
    const code = "424242";
    db.run("UPDATE files SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0 WHERE id = ?", crypto.createHash("sha256").update(f.id + ":" + code).digest("hex"), new Date(Date.now() + 600_000).toISOString(), f.id);
    const verify = (c: string, ip: string) =>
      verifyPOST(new Request(`http://localhost:3000/api/sign/${tok}/verify`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip }, body: JSON.stringify({ code: c }) }), { params: Promise.resolve({ token: tok }) });
    const wrong = await Promise.all(Array.from({ length: 30 }, (_, i) => verify(String(100000 + i), `203.0.113.${i + 1}`)));
    const statuses = wrong.map((r) => r.status);
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(5);
    expect((await verify(code, "198.51.100.9")).status).toBe(429);
  });

  it("signing and countersigning still work end to end with every fix in place", async () => {
    const { f, tok } = await file();
    expect((await mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {})).status).toBe("signed");
    expect((await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {})).status).toBe("completed");
    const r = await mod.readiness(mod.getFile(ws.id, f.id));
    expect(r.ready).toBe(true);
    // the client's link no longer serves the in-progress PDF once signed (it has its own download)
    expect((await pdf(tok)).status).toBe(409);
  });
});
