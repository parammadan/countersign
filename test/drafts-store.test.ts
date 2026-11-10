import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DRAFTS_DDL } from "@/lib/drafts/schema";
import { draftStore, type ContentCheck } from "@/lib/drafts/store";
import type { Principal } from "@/lib/drafts/roles";

// Stub parents for the foreign keys; the real ones come from lib/db.ts migrations 1-7.
const PARENTS = `
  CREATE TABLE workspaces (id TEXT PRIMARY KEY);
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE template_versions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
  INSERT INTO workspaces VALUES ('ws-a'), ('ws-b');
  INSERT INTO users VALUES ('owner-a'), ('admin-a'), ('staff-a'), ('staff2-a'), ('owner-b');
  INSERT INTO template_versions VALUES ('tv1', 'ws-a'), ('tv-b', 'ws-b');
`;
const P = {
  ownerA: { userId: "owner-a", workspaceId: "ws-a", role: "owner" },
  adminA: { userId: "admin-a", workspaceId: "ws-a", role: "admin" },
  staffA: { userId: "staff-a", workspaceId: "ws-a", role: "staff" },
  staff2A: { userId: "staff2-a", workspaceId: "ws-a", role: "staff" },
  ownerB: { userId: "owner-b", workspaceId: "ws-b", role: "owner" },
} satisfies Record<string, Principal>;
const doc = (fee = "USD 5,000") => ({ schema: 1, title: "Services", parties: [], clauses: [{ id: "fees", text: fee }], origin: { kind: "generated" } });
const pass: ContentCheck = () => ({ ok: true });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

let db: DatabaseSync;
let s: ReturnType<typeof draftStore>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(PARENTS);
  db.exec(DRAFTS_DDL);
  s = draftStore(db);
});
function created(by: Principal = P.staffA) {
  const r = s.create(by, { kind: "services", title: "Acme services", doc: doc(), origin: "generated" });
  if (!r.ok) throw new Error(r.message);
  return r.draftId;
}
/** staff edits v2, submits; returns draft id at pending_approval v2 */
function pending() {
  const id = created();
  expect(code(s.commit(P.staffA, id, { expected: 1, doc: doc("USD 6,000") }))).toBe("ok");
  expect(code(s.submit(P.staffA, id, 2))).toBe("ok");
  return id;
}

describe("happy path", () => {
  it("create → commit → submit → approve → publish, with an approval log", () => {
    const id = pending();
    expect(code(s.approve(P.adminA, id, 2, pass))).toBe("ok");
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv1"))).toBe("ok");
    const g = s.get(P.staffA, id);
    expect(g.ok && g.draft.status).toBe("published");
    expect(g.ok && g.draft.approved_by).toBe("admin-a");
    expect(g.ok && g.version.number).toBe(2);
    const acts = db.prepare("SELECT action, actor, version_number FROM draft_approvals WHERE draft_id = ? ORDER BY rowid").all(id).map((r) => ({ ...r }));
    expect(acts).toEqual([
      { action: "submit", actor: "staff-a", version_number: 2 },
      { action: "approve", actor: "admin-a", version_number: 2 },
      { action: "publish", actor: "owner-a", version_number: 2 },
    ]);
  });
});

describe("roles (editing never implies approval)", () => {
  it("staff can create, edit and submit but never approve, send back or publish", () => {
    const id = pending();
    expect(code(s.approve(P.staff2A, id, 2, pass))).toBe("forbidden");
    expect(code(s.requestChanges(P.staff2A, id))).toBe("forbidden");
    expect(code(s.approve(P.adminA, id, 2, pass))).toBe("ok");
    expect(code(s.publish(P.staffA, id, 2, pass, "tv1"))).toBe("forbidden");
  });
  it("the last editor cannot approve, even as owner", () => {
    const id = created(P.ownerA);
    s.commit(P.ownerA, id, { expected: 1, doc: doc("USD 7,000") });
    s.submit(P.ownerA, id, 2);
    expect(code(s.approve(P.ownerA, id, 2, pass))).toBe("same_person");
    expect(code(s.approve(P.adminA, id, 2, pass))).toBe("ok");
  });
  it("a request-supplied role does not count", () => {
    const id = pending();
    expect(code(s.approve({ userId: "staff2-a", workspaceId: "ws-a", role: "approver" }, id, 2, pass))).toBe("unauthenticated");
    expect(code(s.approve(null, id, 2, pass))).toBe("unauthenticated");
  });
});

describe("cross-tenant", () => {
  it("another workspace's owner gets not_found for every operation, and nothing changes", () => {
    const id = pending();
    const before = JSON.stringify(db.prepare("SELECT * FROM drafts").all());
    expect(code(s.get(P.ownerB, id))).toBe("not_found");
    expect(code(s.commit(P.ownerB, id, { expected: 2, doc: doc("USD 1") }))).toBe("not_found");
    expect(code(s.submit(P.ownerB, id, 2))).toBe("not_found");
    expect(code(s.approve(P.ownerB, id, 2, pass))).toBe("not_found");
    expect(code(s.requestChanges(P.ownerB, id))).toBe("not_found");
    expect(code(s.publish(P.ownerB, id, 2, pass, "tv1"))).toBe("not_found");
    expect(JSON.stringify(db.prepare("SELECT * FROM drafts").all())).toBe(before);
    expect(s.get(P.ownerB, id)).toEqual(s.get(P.ownerB, "drf_missing"));
  });
  it("list shows only the principal's workspace", () => {
    created(P.staffA);
    const b = s.create(P.ownerB, { kind: "nda", title: "B", doc: doc(), origin: "upload" });
    expect(b.ok).toBe(true);
    const la = s.list(P.staffA), lb = s.list(P.ownerB);
    expect(la.ok && la.drafts.map((d) => d.workspace_id)).toEqual(["ws-a"]);
    expect(lb.ok && lb.drafts.map((d) => d.workspace_id)).toEqual(["ws-b"]);
  });
  it("a workspace id in the input is ignored: drafts land in the principal's workspace", () => {
    const r = s.create(P.staffA, { kind: "services", title: "x", doc: doc(), origin: "generated", workspaceId: "ws-b" } as never);
    expect(r.ok && (db.prepare("SELECT workspace_id FROM drafts WHERE id = ?").get(r.draftId) as { workspace_id: string }).workspace_id).toBe("ws-a");
  });
});

describe("content check is mandatory and runs on the exact version", () => {
  it("approve and publish refuse without a check, when it says no, and when it throws", () => {
    const id = pending();
    expect(code(s.approve(P.adminA, id, 2, undefined as unknown as ContentCheck))).toBe("check_failed");
    expect(code(s.approve(P.adminA, id, 2, () => ({ ok: false, reason: "party drift" })))).toBe("check_failed");
    expect(code(s.approve(P.adminA, id, 2, () => { throw new Error("boom"); }))).toBe("check_failed");
    expect(code(s.approve(P.adminA, id, 2, () => ({ ok: "yes" }) as never))).toBe("check_failed");
    expect(code(s.approve(P.adminA, id, 2, pass))).toBe("ok");
    expect(code(s.publish(P.ownerA, id, 2, () => ({ ok: false, reason: "not renderable" }), "tv1"))).toBe("check_failed");
    expect(s.get(P.ownerA, id).ok && (s.get(P.ownerA, id) as { draft: { status: string } }).draft.status).toBe("approved");
  });
  it("the check sees the latest committed document", () => {
    const id = pending();
    let seen: unknown;
    s.approve(P.adminA, id, 2, (d) => { seen = d; return { ok: true }; });
    expect(seen).toEqual(doc("USD 6,000"));
  });
});

describe("state machine and concurrency", () => {
  it("two editors on version 1: one gets v2, the other is stale", () => {
    const id = created();
    expect(code(s.commit(P.staffA, id, { expected: 1, doc: doc("A") }))).toBe("ok");
    expect(code(s.commit(P.staff2A, id, { expected: 1, doc: doc("B") }))).toBe("stale");
    const n = db.prepare("SELECT count(*) AS n FROM draft_versions WHERE draft_id = ?").get(id) as { n: number };
    expect(n.n).toBe(2);
  });
  it("a commit after approval clears it and returns to draft; approving a stale version is refused", () => {
    const id = pending();
    expect(code(s.approve(P.adminA, id, 2, pass))).toBe("ok");
    expect(code(s.commit(P.staff2A, id, { expected: 2, doc: doc("USD 9,999") }))).toBe("ok");
    const g = s.get(P.ownerA, id);
    expect(g.ok && [g.draft.status, g.draft.approved_by, g.draft.last_editor]).toEqual(["draft", null, "staff2-a"]);
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv1"))).toBe("stale");
    expect(code(s.publish(P.ownerA, id, 3, pass, "tv1"))).toBe("invalid_state");
  });
  it("illegal jumps are refused", () => {
    const id = created();
    expect(code(s.approve(P.adminA, id, 1, pass))).toBe("invalid_state");
    expect(code(s.publish(P.ownerA, id, 1, pass, "tv1"))).toBe("invalid_state");
    expect(code(s.requestChanges(P.adminA, id))).toBe("invalid_state");
    expect(code(s.submit(P.staffA, id, 1))).toBe("ok");
    expect(code(s.submit(P.staffA, id, 1))).toBe("invalid_state");
  });
  it("a published draft is final", () => {
    const id = pending();
    s.approve(P.adminA, id, 2, pass);
    s.publish(P.ownerA, id, 2, pass, "tv1");
    expect(code(s.commit(P.ownerA, id, { expected: 2, doc: doc("x") }))).toBe("invalid_state");
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv1"))).toBe("invalid_state");
  });
  it("request changes sends a submitted draft back and clears nothing it shouldn't", () => {
    const id = pending();
    expect(code(s.requestChanges(P.adminA, id))).toBe("ok");
    expect(s.get(P.staffA, id).ok && (s.get(P.staffA, id) as { draft: { status: string } }).draft.status).toBe("draft");
  });
  it("the database itself refuses approved_by = last_editor and published without a version", () => {
    const id = pending();
    expect(() => db.prepare("UPDATE drafts SET approved_by = last_editor WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE drafts SET status = 'published' WHERE id = ?").run(id)).toThrow(/CHECK/);
  });
});

describe("input validation", () => {
  it("bad kind, title, origin, doc and expected are refused", () => {
    expect(code(s.create(P.staffA, { kind: "", title: "t", doc: doc(), origin: "generated" }))).toBe("invalid");
    expect(code(s.create(P.staffA, { kind: "k", title: "x".repeat(301), doc: doc(), origin: "generated" }))).toBe("invalid");
    expect(code(s.create(P.staffA, { kind: "k", title: "t", doc: doc(), origin: "edit" as never }))).toBe("invalid");
    expect(code(s.create(P.staffA, { kind: "k", title: "t", doc: [] as never, origin: "generated" }))).toBe("invalid");
    expect(code(s.create(P.staffA, { kind: "k", title: "t", doc: { big: "x".repeat(2_000_001) }, origin: "generated" }))).toBe("invalid");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(code(s.create(P.staffA, { kind: "k", title: "t", doc: cyc, origin: "generated" }))).toBe("invalid");
    const id = created();
    for (const expected of [0, -1, 1.5, "1", null]) expect(code(s.commit(P.staffA, id, { expected, doc: doc() }))).not.toBe("ok");
    expect(code(s.publish(P.ownerA, id, 1, pass, ""))).toBe("invalid");
  });
});

describe("review of 5a8d9dc", () => {
  it("publish refuses another workspace's agreement version and a missing one, as a Result", () => {
    const id = pending();
    s.approve(P.adminA, id, 2, pass);
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv-b"))).toBe("not_found");
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv-missing"))).toBe("not_found");
    const g = s.get(P.ownerA, id);
    expect(g.ok && [g.draft.status, g.draft.published_version_id]).toEqual(["approved", null]);
    expect(code(s.publish(P.ownerA, id, 2, pass, "tv1"))).toBe("ok");
  });
  it("rollback needs an earlier version number and restores that version's stored content, not the request's", () => {
    const id = created();
    s.commit(P.staffA, id, { expected: 1, doc: doc("USD 6,000") });
    for (const restoredFrom of [undefined, 0, -1, 1.5, 3, 99, "1", [1], {}] as unknown[])
      expect(code(s.commit(P.staffA, id, { expected: 2, doc: doc(), origin: "rollback", restoredFrom: restoredFrom as number }))).toBe("invalid");
    expect(code(s.commit(P.staffA, id, { expected: 2, doc: doc("USD 1 (forged)"), origin: "rollback", restoredFrom: 1 }))).toBe("ok");
    const g = s.get(P.staffA, id);
    expect(g.ok && g.version.doc).toEqual(doc());
    expect(g.ok && g.version.origin).toBe("rollback");
  });
  it("the content check gets the first version as its baseline", () => {
    const id = pending();
    let ctx: unknown;
    s.approve(P.adminA, id, 2, (_d, c) => { ctx = c; return { ok: true }; });
    expect(ctx).toEqual({ first: doc(), versionNumber: 2 });
  });
  it("an owner who last edited can send their own submitted draft back, but not approve it", () => {
    const id = created(P.ownerA);
    s.submit(P.ownerA, id, 1);
    expect(code(s.approve(P.ownerA, id, 1, pass))).toBe("same_person");
    expect(code(s.requestChanges(P.ownerA, id))).toBe("ok");
    expect(code(s.requestChanges(P.staffA, id))).toBe("forbidden");
  });
  it("a principal whose user row is missing gets a Result, not a throw", () => {
    expect(code(s.create({ userId: "ghost", workspaceId: "ws-a", role: "owner" }, { kind: "k", title: "t", doc: doc(), origin: "generated" }))).toBe("invalid");
  });
  it("a second connection holding the write lock gives stale, not a throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafts-busy-"));
    const file = path.join(dir, "t.db");
    const a = new DatabaseSync(file), b = new DatabaseSync(file);
    a.exec(PARENTS); a.exec(DRAFTS_DDL);
    b.exec("PRAGMA busy_timeout = 0");
    const sa = draftStore(a), sb = draftStore(b);
    const r = sa.create(P.staffA, { kind: "k", title: "t", doc: doc(), origin: "generated" });
    if (!r.ok) throw new Error(r.message);
    a.exec("BEGIN IMMEDIATE");
    expect(code(sb.commit(P.staff2A, r.draftId, { expected: 1, doc: doc("B") }))).toBe("stale");
    expect(code(sb.submit(P.staff2A, r.draftId, 1))).toBe("stale");
    a.exec("ROLLBACK");
    a.close(); b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
