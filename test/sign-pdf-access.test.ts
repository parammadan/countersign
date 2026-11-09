// The signing link's PDF (/api/sign/[token]/pdf) follows the signing page (app/s/[token]/page.tsx): the agreement
// is only shown while it is waiting for the client's signature (sent or viewed). A draft, declined, expired or
// voided file, or one already signed or completed, doesn't serve it; the completed copy has its own download route.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-signpdf-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("the signing link's PDF follows the signing page", () => {
  let mod: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let GET: typeof import("../app/api/sign/[token]/pdf/route").GET;
  let ws: import("../lib/types").Workspace;
  let templateId = "";
  let n = 0;

  async function file(send = true) {
    const f = await mod.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: `jordan${++n}@example.com`, ref: `SP-${n}` }, { kind: "system", label: "test" }, {}, send);
    return { f, tok: new URL(mod.signingLink(f)!).pathname.split("/").pop()! };
  }
  const pdf = (tok: string) => GET(new Request(`http://localhost:3000/api/sign/${tok}/pdf`), { params: Promise.resolve({ token: tok }) });

  beforeAll(async () => {
    db = await import("../lib/db");
    mod = await import("../lib/files");
    const tpl = await import("../lib/templates");
    GET = (await import("../app/api/sign/[token]/pdf/route")).GET;
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, auto_countersign, created_at) VALUES ('ws_sp','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_sp',0,?)",
      new Date().toISOString(),
    );
    ws = mod.getWorkspace("ws_sp");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
    templateId = r.template.id;
  });

  it("is served while the agreement waits for the client's signature (sent, viewed)", async () => {
    const { f, tok } = await file();
    expect((await pdf(tok)).status).toBe(200);
    mod.markViewed(mod.getFile(ws.id, f.id), ws, {});
    expect(mod.getFile(ws.id, f.id).status).toBe("viewed");
    const res = await pdf(tok);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("isn't served once the client declined", async () => {
    const { tok } = await file();
    await mod.declineFile(tok, "Not the terms we agreed", {});
    expect((await pdf(tok)).status).toBe(410);
  });

  it("isn't served for a draft that was never sent", async () => {
    const { f, tok } = await file(false);
    expect(mod.getFile(ws.id, f.id).status).toBe("draft");
    expect((await pdf(tok)).status).toBe(404);
  });

  it("isn't served once the link expired", async () => {
    const { f, tok } = await file();
    db.run("UPDATE files SET expires_at = ? WHERE id = ?", new Date(Date.now() - 60_000).toISOString(), f.id);
    expect((await pdf(tok)).status).toBe(410);
    expect(mod.getFile(ws.id, f.id).status).toBe("expired");
  });

  it("isn't served once voided (unchanged)", async () => {
    const { f, tok } = await file();
    mod.voidFile(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, "Sent to the wrong client", {});
    expect((await pdf(tok)).status).toBe(410);
  });

  it("isn't served after signing or completion; the completed copy has its own download", async () => {
    const { f, tok } = await file();
    await mod.completeClientSigning(tok, { consent: true, values: {}, signature: PNG, method: "drawn" }, {});
    expect((await pdf(tok)).status).toBe(409);
    await mod.countersign(mod.getFile(ws.id, f.id), ws, { kind: "user", label: "avery@example.com" }, {});
    expect(mod.getFile(ws.id, f.id).status).toBe("completed");
    expect((await pdf(tok)).status).toBe(409);
  });
});
