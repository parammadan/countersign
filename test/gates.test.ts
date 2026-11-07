// Rules that were only covered by reading the code: the publish gate, the per-IP rate limiter, and prefilled
// values reaching the signed PDF.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateForPublish, type Field } from "../lib/fields";
import { limited } from "../lib/ratelimit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-gates-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

const page = { width: 612, height: 792 };
const f = (p: Partial<Field>): Field => ({ id: "f1", type: "signature", role: "client", page: 0, x: 100, y: 100, w: 180, h: 30, label: "Signature", required: true, ...p });

describe("publish gate", () => {
  it("needs a client signature", () => {
    expect(validateForPublish([], [page])).toContain("Add at least one client signature field.");
    expect(validateForPublish([f({ role: "firm" })], [page])).toContain("Add at least one client signature field.");
    expect(validateForPublish([f({ type: "initials" })], [page])).toContain("Add at least one client signature field.");
    expect(validateForPublish([f({})], [page])).toEqual([]);
  });
  it("refuses fields off the page or on a missing page", () => {
    expect(validateForPublish([f({}), f({ id: "f2", x: 500, w: 200, label: "Wide" })], [page]).join(" ")).toMatch(/"Wide" is outside the page/);
    expect(validateForPublish([f({}), f({ id: "f2", page: 3, label: "Lost" })], [page]).join(" ")).toMatch(/"Lost" is on a page that doesn't exist/);
  });
  it("needs a data source for prefilled fields, and never prefills a signature", () => {
    expect(validateForPublish([f({}), f({ id: "f2", role: "prefill", type: "text", label: "Fee" })], [page]).join(" ")).toMatch(/"Fee" needs a data source/);
    expect(validateForPublish([f({}), f({ id: "f2", role: "prefill", type: "signature", label: "Forged", prefillKey: "client.name" })], [page]).join(" ")).toMatch(/signatures can't be filled from file data/);
  });
});

describe("rate limiter", () => {
  it("allows max requests per window per key, then refuses until the window resets", async () => {
    const key = `t:${Math.random()}`;
    const results = Array.from({ length: 6 }, () => limited(key, 5, 200));
    expect(results).toEqual([false, false, false, false, false, true]);
    expect(limited(`${key}:other`, 5, 200)).toBe(false); // keys are independent
    await new Promise((r) => setTimeout(r, 250));
    expect(limited(key, 5, 200)).toBe(false);
  });
});

describe("prefill reaches the signed PDF", () => {
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let extract: typeof import("../lib/pdf/extract");
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    extract = await import("../lib/pdf/extract");
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_g','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_g',?)", new Date().toISOString());
  });

  it("the value asked at file creation is stamped into the completed agreement", async () => {
    const ws = files.getWorkspace("ws_g");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("public/samples/sample-client-agreement.pdf"), filename: "sample.pdf" }, { actor: "test" });
    const fields = JSON.parse(version.fields_json) as Field[];
    const fee = fields.find((x) => x.role === "prefill" && x.prefillKey?.startsWith("custom."));
    expect(fee, "the sample agreement asks for a value at file creation").toBeTruthy();
    tpl.publishVersion(ws.id, version.id, "test");
    const file = await files.createFile(ws, { templateId: template.id, clientName: "Jordan Sample", clientEmail: "jordan@example.com", prefill: { [fee!.prefillKey!.slice(7)]: "4,875.00" } }, { kind: "system", label: "test" }, {});
    const tok = new URL(files.signingLink(file)!).pathname.split("/").pop()!;
    const { fields: signFields } = files.loadByToken(tok)!;
    const values: Record<string, string> = {};
    for (const x of signFields) if (x.role === "client" && !["signature", "initials", "checkbox", "date"].includes(x.type)) values[x.id] = "Test entry";
    const done = await files.completeClientSigning(tok, { consent: true, values, signature: PNG, initials: PNG, method: "drawn" }, {});
    expect(done.status).toBe("completed");
    const doc = files.finalDocument(done)!;
    const ex = await extract.extractPdf(new Uint8Array(fs.readFileSync(path.join(dir, "blobs", doc.path))));
    const text = ex.pages.flatMap((p) => p.items.map((i) => i.str)).join(" ");
    expect(text).toContain("4,875.00");
    expect(text).toContain("Jordan Sample");
  });
});
