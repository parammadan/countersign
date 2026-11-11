// Every session and API-key route that reads workspace data must answer 404 for another workspace's ids,
// 403 for staff where admin is required, and 401 without credentials. Synthetic data only.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-iso-"));
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";

const jar = { cookie: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "cs_session" && jar.cookie ? { value: jar.cookie } : undefined), set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

type Params = { params: Promise<{ id: string }> };
const P = (id: string): Params => ({ params: Promise.resolve({ id }) });

describe("workspace isolation and roles on routes", () => {
  let db: typeof import("../lib/db");
  let util: typeof import("../lib/util");
  let files: typeof import("../lib/files");
  let fileId = "";
  let versionId = "";
  let ipN = 0;
  const keyA = "cs_live_isolation_test_key_a_0001";
  const keyB = "cs_live_isolation_test_key_b_0002";
  const R: Record<string, Record<string, (id: string) => Promise<Response>>> = {};

  const req = (url: string, init: RequestInit = {}) =>
    new Request(`http://localhost:3000${url}`, { ...init, headers: { "x-forwarded-for": `192.0.2.${++ipN % 250}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

  function user(uid: string, ws: string, role: string, cookie: string) {
    db.run("INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", uid, `${uid}@example.test`, uid, "x", new Date().toISOString());
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", ws, uid, role, new Date().toISOString());
    db.run("INSERT INTO sessions (id_hash, user_id, workspace_id, expires_at, created_at) VALUES (?,?,?,?,?)", util.sha256(cookie), uid, ws, "2999-01-01T00:00:00.000Z", new Date().toISOString());
  }

  beforeAll(async () => {
    db = await import("../lib/db");
    util = await import("../lib/util");
    files = await import("../lib/files");
    const tpl = await import("../lib/templates");
    for (const w of ["ws_a", "ws_b"])
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", w, w, w, w, "Avery Tester", "avery@example.test", `tok-${w}`, new Date().toISOString());
    user("usr_a_owner", "ws_a", "owner", "cookie-a-owner");
    user("usr_a_staff", "ws_a", "staff", "cookie-a-staff");
    user("usr_b_owner", "ws_b", "owner", "cookie-b-owner");
    for (const [w, k] of [["ws_a", keyA], ["ws_b", keyB]])
      db.run("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)", `key_${w}`, w, "Test key", k.slice(0, 12), util.sha256(k), new Date().toISOString());
    const wsA = files.getWorkspace("ws_a");
    const { template, version } = await tpl.ingestAgreement(wsA, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    versionId = version.id;
    tpl.publishVersion("ws_a", version.id, "test");
    const f = await files.createFile(wsA, { templateId: template.id, clientName: "Jordan Sample", clientEmail: "jordan@example.test", ref: "ISO-1" }, { kind: "system", label: "test" }, {}, false);
    fileId = f.id;

    const m = async (p: string) => await import(p);
    const doc = await m("../app/api/files/[id]/document/route");
    const vpdf = await m("../app/api/versions/[id]/pdf/route");
    const vfields = await m("../app/api/versions/[id]/fields/route");
    const vpub = await m("../app/api/versions/[id]/publish/route");
    const v1file = await m("../app/api/v1/files/[id]/route");
    const v1doc = await m("../app/api/v1/files/[id]/document/route");
    const v1remind = await m("../app/api/v1/files/[id]/remind/route");
    const v1void = await m("../app/api/v1/files/[id]/void/route");
    R.session = {
      "GET files/[id]/document": (id) => doc.GET(req(`/api/files/${id}/document`), P(id)),
      "GET versions/[id]/pdf": (id) => vpdf.GET(req(`/api/versions/${id}/pdf`), P(id)),
      "PUT versions/[id]/fields": (id) => vfields.PUT(req(`/api/versions/${id}/fields`, { method: "PUT", body: JSON.stringify({ fields: [] }) }), P(id)),
      "POST versions/[id]/publish": (id) => vpub.POST(req(`/api/versions/${id}/publish`, { method: "POST" }), P(id)),
    };
    R.key = {
      "GET v1/files/[id]": (id) => v1file.GET(req(`/api/v1/files/${id}`, { headers: { authorization: `Bearer ${jar.cookie}` } }), P(id)),
      "GET v1/files/[id]/document": (id) => v1doc.GET(req(`/api/v1/files/${id}/document`, { headers: { authorization: `Bearer ${jar.cookie}` } }), P(id)),
      "POST v1/files/[id]/remind": (id) => v1remind.POST(req(`/api/v1/files/${id}/remind`, { method: "POST", headers: { authorization: `Bearer ${jar.cookie}` } }), P(id)),
      "POST v1/files/[id]/void": (id) => v1void.POST(req(`/api/v1/files/${id}/void`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${jar.cookie}` } }), P(id)),
    };
  });

  const idFor = (name: string) => (name.includes("versions") ? versionId : fileId);

  it("session routes: another workspace's ids are 404", async () => {
    jar.cookie = "cookie-b-owner";
    for (const [name, call] of Object.entries(R.session)) {
      const r = await call(idFor(name));
      expect(r.status, name).toBe(404);
    }
  });

  it("session routes: no cookie is 401", async () => {
    jar.cookie = undefined;
    for (const [name, call] of Object.entries(R.session)) expect((await call(idFor(name))).status, name).toBe(401);
  });

  it("session routes: staff is refused (403) where admin is required, even for their own workspace's ids", async () => {
    jar.cookie = "cookie-a-staff";
    for (const name of ["PUT versions/[id]/fields", "POST versions/[id]/publish"]) expect((await R.session[name](versionId)).status, name).toBe(403);
  });

  it("API routes: another workspace's key sees 404 for every file route, and no key is 401", async () => {
    jar.cookie = keyB;
    for (const [name, call] of Object.entries(R.key)) expect((await call(fileId)).status, name).toBe(404);
    jar.cookie = "cs_live_nope";
    for (const [name, call] of Object.entries(R.key)) expect((await call(fileId)).status, name).toBe(401);
    // the owner workspace's own key still reaches it
    jar.cookie = keyA;
    expect((await R.key["GET v1/files/[id]"](fileId)).status).toBe(200);
  });

  it("404 bodies do not echo another workspace's data", async () => {
    jar.cookie = keyB;
    const t = await (await R.key["GET v1/files/[id]"](fileId)).text();
    expect(t).not.toMatch(/Jordan|jordan@|ISO-1|ws_a/);
  });
});
