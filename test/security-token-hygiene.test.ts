// Tokens (signing link, session cookie, API key, inbound URL) must be stored only hashed or sealed, and must not
// appear in the audit trail, the email log, error bodies or console output. Synthetic data only.
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-hyg-"));
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }), headers: async () => new Headers() }));

describe("token storage and leakage", () => {
  let db: typeof import("../lib/db");
  let files: typeof import("../lib/files");
  let signingToken = "";
  let fileId = "";
  const logs: string[] = [];

  // every text value in every table except the one sealed column
  function dump(): { table: string; col: string; value: string }[] {
    const out: { table: string; col: string; value: string }[] = [];
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
      for (const row of db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`))
        for (const [col, v] of Object.entries(row)) if (typeof v === "string" && !(name === "files" && col === "token_enc")) out.push({ table: name, col, value: v });
    return out;
  }
  const leaks = (secret: string) => dump().filter((d) => d.value.includes(secret)).map((d) => `${d.table}.${d.col}`);

  beforeAll(async () => {
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" ")));
    db = await import("../lib/db");
    files = await import("../lib/files");
    const tpl = await import("../lib/templates");
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_h','H','H','H','Avery Tester','avery@example.test','hyg-inbound-token',?)", new Date().toISOString());
    const ws = files.getWorkspace("ws_h");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, version.id, "test");
    const f = await files.createFile(ws, { templateId: template.id, clientName: "Jordan Sample", clientEmail: "jordan@example.test", ref: "HYG-1" }, { kind: "system", label: "test" }, {}, true);
    fileId = f.id;
    signingToken = new URL(files.signingLink(f)!).pathname.split("/").pop()!;
  });

  it("the signing token is stored only as a hash or sealed, never raw", () => {
    expect(signingToken.length).toBeGreaterThanOrEqual(24);
    expect(leaks(signingToken)).toEqual([]);
    expect(db.one<{ token_enc: string }>("SELECT token_enc FROM files WHERE id = ?", fileId)!.token_enc).not.toContain(signingToken);
  });

  it("the signing token is not in the audit trail or the email log after sending", () => {
    expect(leaks(signingToken)).toEqual([]); // dump() covers the audit and email tables
    expect(logs.join("\n")).not.toContain(signingToken);
  });

  it("an unknown or malformed signing token gives an error that does not echo it", async () => {
    const { GET } = await import("../app/api/sign/[token]/pdf/route");
    const bad = "bad-token-should-not-be-echoed-0001";
    const r = await GET(new Request(`http://localhost:3000/api/sign/${bad}/pdf`, { headers: { "x-forwarded-for": "198.51.100.77" } }), { params: Promise.resolve({ token: bad }) });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain(bad);
    expect(logs.join("\n")).not.toContain(bad);
  });

  it("a legacy inbound token is hashed after first use and never reaches the audit trail or logs", async () => {
    const { POST } = await import("../app/api/inbound/[token]/route");
    const t = "hyg-inbound-token";
    await POST(new Request(`http://localhost:3000/api/inbound/${t}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.78" }, body: JSON.stringify({ name: "Jordan Sample", email: "jordan2@example.test", ref: "HYG-2", send: false }) }), { params: Promise.resolve({ token: t }) });
    expect(leaks(t)).toEqual([]);
    expect(logs.join("\n")).not.toContain(t);
  });
});
