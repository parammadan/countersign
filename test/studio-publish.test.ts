// Agreement Studio against a real (temporary) database: publish creates exactly one agreement, an author never
// approves, and library errors come back as messages. AI is off (no provider configured).
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-studio-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

type Svc = typeof import("../lib/drafts/service");
let svc: Svc;
let db: typeof import("../lib/db");
const at = () => new Date().toISOString();
const S = {
  owner: { userId: "u_owner", workspaceId: "ws_a", role: "owner" as const, userEmail: "owner@example.com" },
  admin: { userId: "u_admin", workspaceId: "ws_a", role: "admin" as const, userEmail: "admin@example.com" },
  staff: { userId: "u_staff", workspaceId: "ws_a", role: "staff" as const, userEmail: "staff@example.com" },
};
const input = {
  kind: "nda" as const,
  parties: [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "Acme Widgets Inc" }],
  terms: { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Delaware" },
};
const agreements = () => (db.one<{ n: number }>("SELECT COUNT(*) n FROM template_versions WHERE workspace_id = 'ws_a'")?.n ?? 0);

beforeAll(async () => {
  db = await import("../lib/db");
  svc = await import("../lib/drafts/service");
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
    "ws_a", "Northwind", "Northwind Advisory, LLC", "Northwind", "Avery Tester", "avery@example.com", "inb_a", at());
  for (const s of Object.values(S)) {
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", s.userId, s.userEmail, s.userId, "h", at());
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_a", s.userId, s.role, at());
  }
});

async function approvedDraft(): Promise<{ id: string; version: number }> {
  const c = await svc.createDraft(S.owner, input);
  if (!c.ok) throw new Error(c.issues.join("; "));
  const g = svc.getDraft(S.owner, c.draftId);
  if (!g.ok) throw new Error(g.message);
  const fees = (g.version.doc as { clauses: { id: string; locked?: boolean; text: string }[] }).clauses.find((x) => !x.locked && x.id !== "parties")!;
  const e = svc.editDraft(S.staff, c.draftId, 1, { op: "replace_clause", clauseId: fees.id, text: `${fees.text} This sentence was added in review.` });
  if (!e.ok) throw new Error(e.message);
  expect(svc.submitDraft(S.staff, c.draftId, 2).ok).toBe(true);
  const a = await svc.approveDraft(S.admin, c.draftId, 2);
  if (!a.ok) throw new Error(a.message);
  return { id: c.draftId, version: 2 };
}

describe("publish is claimed first (review B1)", () => {
  it("two concurrent publishes create exactly one agreement", async () => {
    const d = await approvedDraft();
    const before = agreements();
    const [x, y] = await Promise.all([svc.publishDraft(S.owner, d.id, d.version), svc.publishDraft(S.admin, d.id, d.version)]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(agreements() - before).toBe(1);
    const g = svc.getDraft(S.owner, d.id);
    expect(g.ok && g.draft.status).toBe("published");
  });
  it("an edit racing a publish never leaves an orphan agreement", async () => {
    const d = await approvedDraft();
    const before = agreements();
    const pub = svc.publishDraft(S.owner, d.id, d.version);
    const g = svc.getDraft(S.staff, d.id);
    const c = g.ok ? (g.version.doc as { clauses: { id: string; locked?: boolean; text: string }[] }).clauses.find((x) => !x.locked && x.id !== "parties")! : null;
    const edit = c ? svc.editDraft(S.staff, d.id, d.version, { op: "replace_clause", clauseId: c.id, text: `${c.text} Racing edit.` }) : null;
    const r = await pub;
    const after = svc.getDraft(S.owner, d.id);
    if (r.ok) {
      // the publish won: the edit was refused and exactly one agreement exists
      expect(edit?.ok).toBe(false);
      expect(agreements() - before).toBe(1);
      expect(after.ok && after.draft.status).toBe("published");
    } else {
      // the edit won: no agreement was created
      expect(agreements() - before).toBe(0);
      expect(after.ok && after.draft.status).not.toBe("publishing");
    }
  });
  it("a library error (upload limit) returns a message, creates nothing, and leaves the draft approved", async () => {
    const d = await approvedDraft();
    const before = agreements();
    // fill the 30-per-day upload allowance with stub versions
    db.run("INSERT INTO templates (id, workspace_id, name, created_at) VALUES ('tpl_fill', 'ws_a', 'filler', ?)", at());
    const have = agreements();
    for (let i = have; i < 30; i++)
      db.run("INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        `tv_fill_${i}`, "tpl_fill", "ws_a", i + 1, "x.pdf", "x", "x", "0", "[]", "[]", "{}", "draft", at());
    const r = await svc.publishDraft(S.owner, d.id, d.version);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/30 agreement versions/);
    expect(agreements()).toBe(Math.max(before, 30));
    const g = svc.getDraft(S.owner, d.id);
    expect(g.ok && g.draft.status).toBe("approved");
    db.run("DELETE FROM template_versions WHERE template_id = 'tpl_fill'");
  });
});

describe("an author never approves (review B2)", () => {
  it("the owner who created v1 cannot approve after staff edits v2; another admin can", async () => {
    const c = await svc.createDraft(S.owner, input);
    if (!c.ok) throw new Error("create");
    const g = svc.getDraft(S.owner, c.draftId);
    const cl = g.ok ? (g.version.doc as { clauses: { id: string; locked?: boolean; text: string }[] }).clauses.find((x) => !x.locked && x.id !== "parties")! : null;
    expect(svc.editDraft(S.staff, c.draftId, 1, { op: "replace_clause", clauseId: cl!.id, text: `${cl!.text} Edited.` }).ok).toBe(true);
    expect(svc.submitDraft(S.staff, c.draftId, 2).ok).toBe(true);
    const own = await svc.approveDraft(S.owner, c.draftId, 2);
    expect(own.ok === false && own.code).toBe("same_person");
    expect((await svc.approveDraft(S.admin, c.draftId, 2)).ok).toBe(true);
  });
  it("restoring old content does not let its author approve it", async () => {
    const c = await svc.createDraft(S.admin, input);
    if (!c.ok) throw new Error("create");
    const g = svc.getDraft(S.admin, c.draftId);
    const cl = g.ok ? (g.version.doc as { clauses: { id: string; locked?: boolean; text: string }[] }).clauses.find((x) => !x.locked && x.id !== "parties")! : null;
    expect(svc.editDraft(S.admin, c.draftId, 1, { op: "replace_clause", clauseId: cl!.id, text: `${cl!.text} Admin edit.` }).ok).toBe(true);
    expect(svc.rollbackDraft(S.staff, c.draftId, 2, 1).ok).toBe(true); // staff restores the admin-created v1
    expect(svc.submitDraft(S.staff, c.draftId, 3).ok).toBe(true);
    const r = await svc.approveDraft(S.admin, c.draftId, 3);
    expect(r.ok === false && r.code).toBe("same_person");
    expect((await svc.approveDraft(S.owner, c.draftId, 3)).ok).toBe(true);
  });
});

describe("export refuses unprintable PDF text with a message", () => {
  it("returns a Result, not a throw", async () => {
    const c = await svc.createDraft(S.owner, input);
    if (!c.ok) throw new Error("create");
    const pdf = await svc.exportDraft(S.owner, c.draftId, "pdf");
    expect(pdf.ok).toBe(true);
    const docx = await svc.exportDraft(S.owner, c.draftId, "docx");
    expect(docx.ok).toBe(true);
  });
});

describe("publishing an NDA assigns its signature blocks from the draft's parties", () => {
  it("the workspace's party is the countersigner, the other party the client; no signature page is added", async () => {
    const d = await approvedDraft();
    const r = await svc.publishDraft(S.owner, d.id, d.version);
    if (!r.ok) throw new Error(r.message);
    const v = db.one<{ fields_json: string; detection_json: string }>("SELECT fields_json, detection_json FROM template_versions WHERE id = ? AND workspace_id = 'ws_a'", r.agreementVersionId)!;
    const sigs = (JSON.parse(v.fields_json) as { type: string; role: string }[]).filter((f) => f.type === "signature").map((f) => f.role);
    // Northwind (the workspace) is the Disclosing Party, printed first
    expect(sigs).toEqual(["firm", "client"]);
    expect(JSON.parse(v.detection_json).addedSignaturePage).toBe(false);
  });
});

describe("review R1: cancelling a running publish can't orphan an agreement", () => {
  it("a second admin can't cancel a fresh claim, so the second publish never ingests", async () => {
    const d = await approvedDraft();
    const before = agreements();
    const first = svc.publishDraft(S.admin, d.id, d.version);
    // let the first publish take its claim
    for (let i = 0; i < 50; i++) {
      const g = svc.getDraft(S.owner, d.id);
      if (g.ok && g.draft.status !== "approved") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const cancel = svc.abortPublish(S.owner, d.id);
    const second = await svc.publishDraft(S.owner, d.id, d.version);
    const r = await first;
    expect(r.ok).toBe(true);
    expect(cancel.ok === false || !second.ok).toBe(true);
    expect(agreements() - before).toBe(1);
  });
});

