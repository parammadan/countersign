// The signing room checks each field as the client fills it in (lib/sign-fields.ts). Those checks must agree
// with the server's, which stay the authority: a value the room accepts must sign, and a value it refuses
// must also be refused by the server when sent directly.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Field } from "../lib/fields";
import { fieldError, fieldName, inkTooSmall, mustComplete, progressText, remainingAnnouncement } from "../lib/sign-fields";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-signfields-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

const f = (p: Partial<Field>): Field => ({ id: "f1", type: "text", role: "client", page: 0, x: 72, y: 600, w: 180, h: 24, label: "Title", required: true, ...p });

describe("field rules in the signing room", () => {
  it("signatures and initials always need completing; other fields only when required", () => {
    expect(mustComplete(f({ type: "signature", required: false }))).toBe(true);
    expect(mustComplete(f({ type: "initials", required: false }))).toBe(true);
    expect(mustComplete(f({ type: "text", required: false }))).toBe(false);
    expect(mustComplete(f({ type: "checkbox", required: true }))).toBe(true);
    expect(mustComplete(f({ type: "date", required: true })), "the signing date is stamped, not filled in").toBe(false);
  });

  it("names a field by its label, or by its type when it has none", () => {
    expect(fieldName(f({ label: "Job title" }))).toBe("Job title");
    expect(fieldName(f({ label: "  ", type: "company" }))).toBe("Company");
  });

  it("explains what is wrong, in the field's own name", () => {
    expect(fieldError(f({}), "")).toBe('Fill in "Title".');
    expect(fieldError(f({}), "   ")).toBe('Fill in "Title".');
    expect(fieldError(f({}), "Partner")).toBeNull();
    expect(fieldError(f({ required: false }), "")).toBeNull();
    expect(fieldError(f({ type: "email", label: "Billing email" }), "jordan@example")).toMatch(/"Billing email" needs a valid email/);
    expect(fieldError(f({ type: "email", required: false }), "not an email")).toMatch(/needs a valid email/);
    expect(fieldError(f({ type: "email" }), " jordan@example.com ")).toBeNull();
    expect(fieldError(f({ type: "checkbox", label: "I agree to the fees" }), false)).toBe('Tick "I agree to the fees" to continue.');
    expect(fieldError(f({ type: "checkbox", required: false }), false)).toBeNull();
    expect(fieldError(f({ type: "date" }), undefined)).toBeNull();
  });

  it("refuses a drawn mark too small to be a signature", () => {
    expect(inkTooSmall("signature", 6, 6)).toBe(true);
    expect(inkTooSmall("signature", 120, 30)).toBe(false);
    expect(inkTooSmall("initials", 10, 12)).toBe(true);
    expect(inkTooSmall("initials", 28, 18)).toBe(false);
  });

  it("says how far along the client is", () => {
    expect(progressText(1, 3, 0)).toBe("1 of 3 required done");
    expect(progressText(3, 3, 2)).toBe("Required done · 2 optional");
    expect(progressText(3, 3, 0)).toBe("Ready to sign");
    expect(remainingAnnouncement(1)).toBe("1 required field left.");
    expect(remainingAnnouncement(0)).toMatch(/All required fields are done/);
  });
});

describe("the server agrees with the signing room", () => {
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let versionId = "";
  let templateId = "";
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const fields: Field[] = [
    f({ id: "sig", type: "signature", label: "Signature", y: 700 }),
    f({ id: "title", type: "text", label: "Title", y: 650 }),
    f({ id: "mail", type: "email", label: "Billing email", y: 620 }),
    f({ id: "agree", type: "checkbox", label: "I agree to the fees", w: 14, h: 14, y: 590 }),
    f({ id: "note", type: "text", label: "Notes", required: false, y: 560 }),
  ];
  const good: Record<string, string | boolean> = { title: "Partner", mail: "billing@example.com", agree: true, note: "" };

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_f','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_f',?)", new Date().toISOString());
    const ws = files.getWorkspace("ws_f");
    const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("public/samples/sample-client-agreement.pdf"), filename: "sample.pdf" }, { actor: "test" });
    db.run("UPDATE template_versions SET fields_json = ? WHERE id = ?", JSON.stringify(fields), version.id);
    tpl.publishVersion(ws.id, version.id, "test");
    versionId = version.id;
    templateId = template.id;
  });

  async function sign(values: Record<string, string | boolean>) {
    const ws = files.getWorkspace("ws_f");
    const file = await files.createFile(ws, { templateId, clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, { kind: "system", label: "test" }, {});
    expect(file.template_version_id).toBe(versionId);
    const tok = new URL(files.signingLink(file)!).pathname.split("/").pop()!;
    return files.completeClientSigning(tok, { consent: true, values, signature: PNG, method: "typed" }, {});
  }

  it("values the room accepts sign", async () => {
    for (const fl of fields) expect(fieldError(fl, good[fl.id]), fl.label).toBeNull();
    const done = await sign(good);
    expect(["signed", "completed"]).toContain(done.status);
  });

  for (const [what, id, value, server] of [
    ["an empty required text field", "title", "  ", /Fill in "Title"/],
    ["a malformed email", "mail", "billing@example", /"Billing email" needs a valid email/],
    ["an unticked required checkbox", "agree", false, /Tick "I agree to the fees"/],
  ] as const) {
    it(`refuses ${what}, in the room and on the server`, async () => {
      const fl = fields.find((x) => x.id === id)!;
      expect(fieldError(fl, value)).not.toBeNull();
      await expect(sign({ ...good, [id]: value })).rejects.toThrow(server);
    });
  }
});
