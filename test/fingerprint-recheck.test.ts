// Every stored PDF is re-hashed against the fingerprint recorded when it was stored before it is signed, sealed or
// served. A blob changed on disk (DATA_DIR) is refused with 409 and the attempt is audited; nothing is stamped,
// sealed or sent. The download hash header is computed from the bytes actually served.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-fp-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

// the firm's routes need a signed-in session; here it is the test workspace's owner
vi.mock("@/lib/http", async (orig) => {
  const real = await orig<typeof import("../lib/http")>();
  const files = await import("../lib/files");
  return {
    ...real,
    sessionOr401: async () => ({ s: { userId: "u_owner", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_fp", role: "owner" }, ws: files.getWorkspace("ws_fp") }),
  };
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const blob = (rel: string) => path.join(dir, "blobs", rel);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Run fn with the blob changed on disk (one byte appended), then put the original back. */
async function tampered<T>(rel: string, fn: () => Promise<T>): Promise<T> {
  const orig = fs.readFileSync(blob(rel));
  fs.writeFileSync(blob(rel), Buffer.concat([orig, Buffer.from("%x")]));
  try {
    return await fn();
  } finally {
    fs.writeFileSync(blob(rel), orig);
  }
}

describe("stored PDFs are re-checked against their fingerprint", () => {
  let mod: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let ws: import("../lib/types").Workspace;
  let templateId = "";
  let version: import("../lib/types").TemplateVersion;
  let n = 0;

  const mismatches = (fileId: string | null) =>
    db.all<{ data_json: string }>("SELECT data_json FROM audit_events WHERE type = 'document.fingerprint_mismatch' AND file_id IS ?", fileId).map((e) => JSON.parse(e.data_json));

  async function newFile() {
    const f = await mod.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: `jordan${++n}@example.com`, ref: `FP-${n}` }, { kind: "system", label: "test" }, {});
    return { f, tok: new URL(mod.signingLink(f)!).pathname.split("/").pop()! };
  }
  const sign = (tok: string) => mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
  const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

  beforeAll(async () => {
    db = await import("../lib/db");
    mod = await import("../lib/files");
    tpl = await import("../lib/templates");
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, auto_countersign, created_at) VALUES ('ws_fp','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_fp',0,?)",
      new Date().toISOString(),
    );
    ws = mod.getWorkspace("ws_fp");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
    templateId = r.template.id;
    version = mod.getVersion(r.version.id);
  });

  it("signing refuses a tampered original: 409, audited, the file is unchanged", async () => {
    const { f, tok } = await newFile();
    const err = await tampered(version.pdf_path, () => sign(tok).then(() => null, (e) => e));
    expect(err).toBeInstanceOf(mod.AppError);
    expect(err.status).toBe(409);
    expect(mod.getFile(ws.id, f.id).status).toBe("sent");
    expect(db.one("SELECT 1 FROM documents WHERE file_id = ?", f.id)).toBeUndefined();
    expect(mismatches(f.id)).toEqual([expect.objectContaining({ document: "original", expected_sha256: version.sha256 })]);
    // intact again: signing works
    expect((await sign(tok)).status).toBe("signed");
  });

  it("countersigning refuses a tampered client-signed PDF: 409, audited, nothing sealed", async () => {
    const { f, tok } = await newFile();
    await sign(tok);
    const doc = db.one<{ path: string }>("SELECT path FROM documents WHERE file_id = ? AND kind = 'client_signed'", f.id)!;
    const err = await tampered(doc.path, () => mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {}).then(() => null, (e) => e));
    expect(err).toBeInstanceOf(mod.AppError);
    expect(err.status).toBe(409);
    expect(mod.getFile(ws.id, f.id).status).toBe("signed");
    expect(db.one("SELECT 1 FROM documents WHERE file_id = ? AND kind = 'final'", f.id)).toBeUndefined();
    expect(mismatches(f.id)).toEqual([expect.objectContaining({ document: "client_signed" })]);
    expect((await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {})).status).toBe("completed");
  });

  it("the signing page's PDF isn't served if the original changed", async () => {
    const { GET } = await import("../app/api/sign/[token]/pdf/route");
    const { f, tok } = await newFile();
    const res = await tampered(version.pdf_path, () => GET(new Request(`http://localhost:3000/api/sign/${tok}/pdf`), params({ token: tok })));
    expect(res.status).toBe(409);
    expect(mismatches(f.id)).toHaveLength(1);
    expect((await GET(new Request(`http://localhost:3000/api/sign/${tok}/pdf`), params({ token: tok }))).status).toBe(200);
  });

  describe("downloads of the sealed copy", () => {
    let f: import("../lib/types").FileRow;
    let tok = "";
    let final: { path: string; sha256: string };
    beforeAll(async () => {
      const made = await newFile();
      tok = made.tok;
      await sign(tok);
      f = await mod.countersign(mod.getFile(ws.id, made.f.id), ws, { kind: "user", label: "avery@example.com" }, {});
      final = db.one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'final'", f.id)!;
    });

    it("the client's download refuses a tampered sealed copy and doesn't record a download", async () => {
      const { GET } = await import("../app/api/sign/[token]/download/route");
      const before = mismatches(f.id).length;
      const res = await tampered(final.path, () => GET(new Request(`http://localhost:3000/api/sign/${tok}/download`), params({ token: tok })));
      expect(res.status).toBe(409);
      expect(mismatches(f.id)).toHaveLength(before + 1);
      expect(db.one("SELECT 1 FROM audit_events WHERE file_id = ? AND type = 'file.downloaded'", f.id)).toBeUndefined();
      expect((await GET(new Request(`http://localhost:3000/api/sign/${tok}/download`), params({ token: tok }))).status).toBe(200);
    });

    it("the firm's download refuses a tampered sealed or client-signed copy", async () => {
      const { GET } = await import("../app/api/files/[id]/document/route");
      const url = `http://localhost:3000/api/files/${f.id}/document`;
      expect((await tampered(final.path, () => GET(new Request(url), params({ id: f.id })))).status).toBe(409);
      const cs = db.one<{ path: string }>("SELECT path FROM documents WHERE file_id = ? AND kind = 'client_signed'", f.id)!;
      expect((await tampered(cs.path, () => GET(new Request(`${url}?kind=client_signed`), params({ id: f.id })))).status).toBe(409);
      expect((await GET(new Request(url), params({ id: f.id }))).status).toBe(200);
    });

    it("the API download refuses a tampered sealed copy, and its X-Content-SHA256 is the hash of the bytes served", async () => {
      const { GET } = await import("../app/api/v1/files/[id]/document/route");
      const key = "cs_live_" + "x".repeat(24); // a test key (built, so it can't look like a real one)
      db.run("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)", "key_fp", ws.id, "test", key.slice(0, 12), sha(Buffer.from(key)), new Date().toISOString());
      const req = () => new Request(`http://localhost:3000/api/v1/files/${f.id}/document`, { headers: { authorization: `Bearer ${key}` } });
      const bad = await tampered(final.path, () => GET(req(), params({ id: f.id })));
      expect(bad.status).toBe(409);
      expect(bad.headers.get("X-Content-SHA256")).toBeNull();
      const ok = await GET(req(), params({ id: f.id }));
      expect(ok.status).toBe(200);
      const body = Buffer.from(await ok.arrayBuffer());
      expect(ok.headers.get("X-Content-SHA256")).toBe(sha(body));
      expect(sha(body)).toBe(final.sha256);
    });
  });

  it("the firm's view of an agreement version refuses a tampered original", async () => {
    const { GET } = await import("../app/api/versions/[id]/pdf/route");
    const req = () => new Request(`http://localhost:3000/api/versions/${version.id}/pdf`, { headers: { origin: "http://localhost:3000" } });
    expect((await tampered(version.pdf_path, () => GET(req(), params({ id: version.id })))).status).toBe(409);
    expect(mismatches(null).some((e) => e.document === `version ${version.id}`)).toBe(true);
    expect((await GET(req(), params({ id: version.id }))).status).toBe(200);
  });
});
