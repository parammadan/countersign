// New client file: the person chooses which published agreement to send. The server uses exactly that agreement's
// published version (not the default) for the file, and the file keeps that version for signing and evidence. Another
// workspace's agreement is refused. The picker lists every published agreement with its version and the default marked.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-choice-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
for (const k of ["SMTP_USER", "SMTP_PASS", "RESEND_API_KEY"]) delete process.env[k];

vi.mock("@/app/actions", () => ({ createFileAction: vi.fn() }));

describe("choosing the agreement for a new client file", () => {
  let db: typeof import("../lib/db");
  let files: typeof import("../lib/files");
  let tpl: typeof import("../lib/templates");
  let ws: import("../lib/types").Workspace;
  const actor = { kind: "system" as const, label: "test" };
  const ids: { tpl: string; ver: string }[] = [];

  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    tpl = await import("../lib/templates");
    const t = new Date().toISOString();
    for (const w of ["ws_c", "ws_x"]) {
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", w, "Northwind", "Northwind Advisory, LLC", "Northwind", "Avery Tester", "owner@example.com", `inb_${w}`, t);
    }
    ws = files.getWorkspace("ws_c");
    for (const f of ["02-msa-two-column.pdf", "03-stacked-provider-customer.pdf", "13-engagement-letter-filled-header.pdf"]) {
      const { template, version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync(`fixtures/agreements/${f}`), filename: f }, { actor: "test" });
      tpl.publishVersion(ws.id, version.id, "test");
      ids.push({ tpl: template.id, ver: version.id });
    }
  });

  it("uses the chosen agreement's published version, not the default", async () => {
    const def = db.one<{ id: string }>("SELECT id FROM templates WHERE workspace_id = 'ws_c' AND is_default = 1")!.id;
    const other = ids.find((x) => x.tpl !== def)!;
    const f = await files.createFile(ws, { templateId: other.tpl, clientName: "Jordan Sample", clientEmail: "owner@example.com" }, actor, {});
    const row = db.one<{ template_version_id: string }>("SELECT template_version_id FROM files WHERE id = ?", f.id)!;
    expect(row.template_version_id).toBe(other.ver);
    expect(row.template_version_id).not.toBe(ids.find((x) => x.tpl === def)!.ver);
  });

  it("refuses an agreement from another workspace", async () => {
    const wx = files.getWorkspace("ws_x");
    await expect(files.createFile(wx, { templateId: ids[0].tpl, clientName: "Jordan Sample", clientEmail: "owner@example.com" }, actor, {})).rejects.toThrow(/Agreement not found/);
  });

  it("the picker lists every published agreement with its version and the default, preselects the one asked for, and says what's being sent", async () => {
    const { NewFileForm, agreementLabel } = await import("@/components/NewFileForm");
    const templates = [
      { id: "tpl_a", name: "Engagement Letter", version: 2, isDefault: true, prefill: [] },
      { id: "tpl_b", name: "Consulting Agreement", version: 1, isDefault: false, prefill: [] },
      { id: "tpl_c", name: "Mutual NDA", version: 3, isDefault: false, prefill: [] },
    ];
    const h = renderToStaticMarkup(createElement(NewFileForm, { templates, initial: "tpl_b" }));
    expect(h).toContain('name="templateId"');
    expect(h).toContain("required");
    for (const t of templates) expect(h).toContain(agreementLabel(t).replace(/'/g, "&#x27;"));
    expect(agreementLabel(templates[0])).toBe("Engagement Letter · version 2 (default)");
    expect(h).toMatch(/<option value="tpl_b" selected="">/);
    expect(h).toMatch(/You&#x27;re sending <span[^>]*>Consulting Agreement<\/span>, version 1/);
    // with one published agreement the picker still shows which one is sent
    const one = renderToStaticMarkup(createElement(NewFileForm, { templates: [templates[0]] }));
    expect(one).toContain('name="templateId"');
    expect(one).toContain("Your only published agreement");
  });
});
