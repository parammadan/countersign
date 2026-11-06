// Service-level lifecycle: upload -> detect -> publish -> create file -> client signs -> auto countersign -> sealed.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-flow-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

// 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("file lifecycle", () => {
  let mod: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let db: typeof import("../lib/db");
  let ws: import("../lib/types").Workspace;

  beforeAll(async () => {
    db = await import("../lib/db");
    mod = await import("../lib/files");
    tpl = await import("../lib/templates");
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_t','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_t',?)",
      new Date().toISOString(),
    );
    ws = mod.getWorkspace("ws_t");
  });

  it("detects, publishes, signs, countersigns and seals", async () => {
    const data = fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf");
    const { template, version } = await tpl.ingestAgreement(ws, { data, filename: "msa.pdf" }, { actor: "test" });
    const fields = JSON.parse(version.fields_json);
    expect(fields.some((f: { role: string; type: string }) => f.role === "client" && f.type === "signature")).toBe(true);
    expect(fields.some((f: { role: string; type: string }) => f.role === "firm" && f.type === "signature")).toBe(true);
    tpl.publishVersion(ws.id, version.id, "test");
    expect(() => tpl.saveFields(ws.id, version.id, fields)).toThrow(/Published/);

    const f = await mod.createFile(ws, { templateId: template.id, clientName: "Jordan Sample", clientEmail: "jordan@example.com", ref: "T-1" }, { kind: "system", label: "test" }, {});
    expect(f.status).toBe("sent");
    await expect(mod.createFile(ws, { clientName: "Dup", clientEmail: "d@example.com", ref: "T-1" }, { kind: "system", label: "test" }, {})).rejects.toThrow(/already exists/);

    const tok = new URL(mod.signingLink(f)!).pathname.split("/").pop()!;
    const values: Record<string, string> = {};
    for (const x of fields) if (x.role === "client" && x.type === "title") values[x.id] = "Owner";

    await expect(mod.completeClientSigning(tok, { consent: true, values, method: "drawn" }, {})).rejects.toThrow(/signature/);
    const done = await mod.completeClientSigning(tok, { consent: true, values, signature: PNG, method: "drawn" }, { ip: "203.0.113.9" });
    expect(done.status).toBe("completed");
    await expect(mod.completeClientSigning(tok, { consent: true, values, signature: PNG, method: "drawn" }, {})).rejects.toThrow(/already/);

    const doc = mod.finalDocument(done)!;
    expect(doc.kind).toBe("final");
    const finalBytes = fs.readFileSync(path.join(dir, "blobs", doc.path));
    if (process.env.FLOW_OUT) fs.writeFileSync(process.env.FLOW_OUT, finalBytes);
    const pdf = await PDFDocument.load(finalBytes);
    const original = await PDFDocument.load(data);
    expect(pdf.getPageCount()).toBe(original.getPageCount() + 1); // + certificate

    const events = db.all<{ type: string }>("SELECT type FROM audit_events WHERE file_id = ? ORDER BY seq", f.id).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["file.created", "file.sent", "file.consented", "file.signed", "file.countersigned", "file.completed"]));
    expect(() => db.run("DELETE FROM audit_events")).toThrow(/append-only/);
    const mails = db.all<{ kind: string; to_email: string }>("SELECT kind, to_email FROM emails WHERE file_id = ?", f.id);
    expect(mails.map((m) => m.kind)).toEqual(expect.arrayContaining(["invite", "completed", "firm_completed"]));

    // no email provider here: the invite was logged, not delivered, and the stored copy has no usable link
    expect(done.email_status).toBe("logged");
    expect(events).not.toContain("file.email_failed"); // logged is not a failure
    const stored = db.all<{ html: string }>("SELECT html FROM emails WHERE file_id = ?", f.id);
    for (const m of stored) expect(m.html).not.toContain(tok);
    expect(stored.some((m) => m.html.includes("withheld from the log"))).toBe(true);

    // ready for work only when every required condition holds, re-checked against the stored PDF
    const r = await mod.readiness(done);
    expect(r.ready).toBe(true);
    expect(r.checks.filter((c) => c.required).every((c) => c.ok)).toBe(true);
    expect(r.checks.find((c) => c.key === "copy_emailed")!.ok).toBe(false); // logged, not delivered
    const blob = path.join(dir, "blobs", doc.path);
    fs.writeFileSync(blob, Buffer.concat([finalBytes, Buffer.from("tamper")]));
    const tampered = await mod.readiness(done);
    expect(tampered.ready).toBe(false);
    expect(tampered.checks.find((c) => c.key === "sealed")!.ok).toBe(false);
    fs.writeFileSync(blob, finalBytes);

    // the client's link to their copy closes 30 days after completion
    expect(mod.copyLinkClosed(done)).toBe(false);
    expect(mod.copyLinkClosed({ ...done, completed_at: new Date(Date.now() - 31 * 86400_000).toISOString() })).toBe(true);

    // a file that isn't finished is never ready
    const open = await mod.createFile(ws, { templateId: template.id, clientName: "Riley Example", clientEmail: "riley@example.com" }, { kind: "system", label: "test" }, {});
    expect((await mod.readiness(open)).ready).toBe(false);
  });

  it("adds a signature page when the agreement has no signature line", async () => {
    const data = fs.readFileSync("fixtures/agreements/09-no-signature.pdf");
    const { version } = await tpl.ingestAgreement(ws, { data, filename: "nosig.pdf" }, { actor: "test" });
    const det = JSON.parse(version.detection_json);
    expect(det.addedSignaturePage).toBe(true);
    const fields = JSON.parse(version.fields_json);
    expect(fields.filter((f: { role: string; type: string }) => f.type === "signature").map((f: { role: string }) => f.role).sort()).toEqual(["client", "firm"]);
  });

  it("rejects files that aren't agreements", async () => {
    await expect(tpl.ingestAgreement(ws, { data: Buffer.from("hello"), filename: "notes.txt" }, { actor: "test" })).rejects.toThrow(/PDF or Word/);
    await expect(tpl.ingestAgreement(ws, { data: Buffer.from("%PDF-1.4 garbage"), filename: "x.pdf" }, { actor: "test" })).rejects.toThrow(/couldn't be read/);
  });
});
