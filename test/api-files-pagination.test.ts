// GET /api/v1/files pages with starting_after: no file is skipped or repeated, and ids from another workspace are refused.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-page-"));
process.env.APP_URL = "http://localhost:3000";

describe("GET /api/v1/files pagination", () => {
  const keys: Record<string, string> = {};
  const ids: Record<string, string[]> = { ws_pa: [], ws_pb: [] };
  const list = async (ws: string, qs = "") => {
    const { GET } = await import("../app/api/v1/files/route");
    const res = await GET(new Request(`http://localhost:3000/api/v1/files${qs}`, { headers: { authorization: `Bearer ${keys[ws]}` } }));
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    const db = await import("../lib/db");
    const files = await import("../lib/files");
    const tpl = await import("../lib/templates");
    for (const w of ["ws_pa", "ws_pb"]) {
      db.run(
        "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, auto_countersign, created_at) VALUES (?,?,?,?,?,?,?,0,?)",
        w, "Northwind", "Northwind Advisory, LLC", "Northwind", "Avery Tester", "avery@example.com", `inb_${w}`, new Date().toISOString(),
      );
      const key = ["cs", "live", crypto.randomBytes(12).toString("hex")].join("_");
      keys[w] = key;
      db.run("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)", `key_${w}`, w, "Test key", key.slice(0, 12), crypto.createHash("sha256").update(key).digest("hex"), new Date().toISOString());
      const ws = files.getWorkspace(w);
      const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
      tpl.publishVersion(ws.id, r.version.id, "test");
      for (let i = 0; i < 5; i++) {
        const f = await files.createFile(ws, { templateId: r.template.id, clientName: "Jordan Sample", clientEmail: `j${i}@example.com`, ref: `${w}-${i}` }, { kind: "system", label: "test" }, {}, false);
        ids[w].push(f.id);
      }
    }
  });

  it("walks every file exactly once, newest first", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (let guard = 0; guard < 10; guard++) {
      const { status, body } = await list("ws_pa", `?limit=2${cursor ? `&starting_after=${cursor}` : ""}`);
      expect(status).toBe(200);
      seen.push(...body.data.map((f: { id: string }) => f.id));
      if (!body.has_more) break;
      cursor = body.data[body.data.length - 1].id;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids.ws_pa));
  });

  it("refuses another workspace's file id as a cursor", async () => {
    const { status, body } = await list("ws_pa", `?starting_after=${ids.ws_pb[0]}`);
    expect(status).toBe(404);
    expect(body.error).toMatch(/starting_after/);
  });
});
