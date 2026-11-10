// Clause library in the app: countersign.db persistence, session-only roles, workspace isolation, and the server
// actions (with forged form fields). Synthetic data only.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-clauses-"));
process.env.DATA_DIR = dir;

// The actions read the session from requireSession() and end in redirect(); both are replaced here.
const session = { current: null as null | Record<string, unknown> };
vi.mock("@/lib/auth", () => ({ requireSession: async () => session.current }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/http", () => ({ ctxFromHeaders: async () => ({ ip: "203.0.113.9", ua: "clause-test" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

type Svc = typeof import("../../lib/clauses/app/service");
type Db = typeof import("../../lib/db");
type Actions = typeof import("../../app/clauses-actions");
let svc: Svc, db: Db, act: Actions;

const S = (userId: string, workspaceId: string, role: "owner" | "admin" | "staff") => ({ userId, workspaceId, role, userName: userId, userEmail: `${userId}@example.com` });
const ownerA = S("u-owner-a", "ws_a", "owner");
const adminA = S("u-admin-a", "ws_a", "admin");
const staffA = S("u-staff-a", "ws_a", "staff");
const adminB = S("u-admin-b", "ws_b", "admin");
const BODY = "{{client.name}} shall pay {{fee:money}} within {{days:int}} days of the invoice date.";
const VALUES = { "client.name": "Example Client LLC", fee: "1500", days: 30 };

function seed() {
  const at = new Date().toISOString();
  for (const ws of ["ws_a", "ws_b"]) {
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ws, `Firm ${ws}`, `Firm ${ws} LLC`, `Firm ${ws}`, "Avery Tester", `avery-${ws}@example.com`, `inb_${ws}`, at,
    );
  }
  for (const s of [ownerA, adminA, staffA, adminB]) {
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", s.userId, s.userEmail, `Name ${s.userId}`, "x", at);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", s.workspaceId, s.userId, s.role, at);
  }
}

const ok = <T,>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return (r as unknown as { value: T }).value;
};
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function redirected(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return url;
    throw e;
  }
  throw new Error("no redirect");
}
function newClause(by = staffA, title = "Payment terms") {
  return ok<{ id: string }>(svc.createClause(by, { title, kind: "payment", body: BODY, source: { kind: "firm_template", ref: "TPL-2026" } })).id;
}

beforeAll(async () => {
  db = await import("../../lib/db");
  svc = await import("../../lib/clauses/app/service");
  act = await import("../../app/clauses-actions");
  seed();
});
beforeEach(() => {
  session.current = null;
});

describe("clause library in countersign.db", () => {
  it("creates its tables at first use, idempotently, without touching PRAGMA user_version", () => {
    const before = db.one<{ user_version: number }>("PRAGMA user_version")!.user_version;
    svc.listClauses(staffA);
    svc.listClauses(staffA);
    expect(db.one<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(before);
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE name LIKE 'clause\\_library\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name);
    expect(names).toEqual([
      "clause_library_clause_frozen", "clause_library_clause_no_delete", "clause_library_clauses", "clause_library_frozen",
      "clause_library_new", "clause_library_no_delete", "clause_library_versions",
    ]);
    expect(db.one<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1); // the app's pragmas are untouched
  });

  it("runs draft -> submit -> approve by another admin -> use, and keeps the history", () => {
    const id = newClause();
    expect(code(svc.submitVersion(staffA, id, 1))).toBe("ok");
    expect(code(svc.approveVersion(adminA, id, 1))).toBe("ok");
    expect(ok<string>(svc.renderApproved(staffA, id, 1, VALUES))).toBe("Example Client LLC shall pay $1,500.00 within 30 days of the invoice date.");
    const c = ok<{ versions: { state: string; approvedBy: string; history: { to: string; by: string }[] }[] }>(svc.getClause(staffA, id));
    expect(c.versions[0]).toMatchObject({ state: "approved", approvedBy: "u-admin-a" });
    expect(c.versions[0].history.map((h) => [h.to, h.by])).toEqual([["draft", "u-staff-a"], ["in_review", "u-staff-a"], ["approved", "u-admin-a"]]);
    expect(svc.memberNames(staffA).get("u-admin-a")).toBe("Name u-admin-a");
  });

  it("persists across connections (it is the app database)", () => {
    const id = newClause(staffA, "Persisted clause");
    const row = db.one<{ n: number }>("SELECT COUNT(*) n FROM clause_library_versions WHERE workspace_id = 'ws_a' AND clause_id = ?", id);
    expect(row!.n).toBe(1);
  });
});

describe("roles come from the session: editing never implies approval", () => {
  it("staff can write and submit but never approve, send back or retire", () => {
    const id = newClause();
    svc.submitVersion(staffA, id, 1);
    expect(code(svc.approveVersion(staffA, id, 1))).toBe("forbidden");
    expect(code(svc.sendBackVersion(staffA, id, 1))).toBe("forbidden");
    svc.approveVersion(ownerA, id, 1);
    expect(code(svc.retireVersion(staffA, id, 1))).toBe("forbidden");
  });
  it("an owner who wrote the text cannot approve it; another admin can", () => {
    const id = newClause(ownerA, "Owner's own clause");
    svc.submitVersion(ownerA, id, 1);
    expect(code(svc.approveVersion(ownerA, id, 1))).toBe("self_approval");
    expect(code(svc.approveVersion(adminA, id, 1))).toBe("ok");
  });
  it("only the author edits or submits a draft", () => {
    const id = newClause();
    expect(code(svc.editDraft(adminA, id, 1, "Changed {{x}}"))).toBe("forbidden");
    expect(code(svc.submitVersion(ownerA, id, 1))).toBe("forbidden");
  });
  it("a malformed or unknown-role session gets nothing", () => {
    for (const bad of [null, {}, { ...staffA, role: "superadmin" }, { ...staffA, workspaceId: "" }, { ...staffA, userId: 5 }]) {
      expect(code(svc.listClauses(bad))).toBe("unauthenticated");
    }
    expect(svc.capabilitiesOf({ ...staffA, role: "superadmin" })).toEqual([]);
  });
  it("the authorizer answers only for the signed-in member", () => {
    const p = svc.principalOf({ ...staffA, roles: ["approver"], extra: "x" })!;
    expect(Object.keys(p).sort()).toEqual(["label", "role", "userId", "workspaceId"]); // never "roles" or "extra"
    expect(p.label).toBe("u-staff-a@example.com");
    const a = svc.authorizerFor(p);
    expect(a.rolesOf("ws_a", "u-staff-a")).toEqual(["viewer", "editor"]);
    expect(a.rolesOf("ws_a", "u-owner-a")).toBeNull();
    expect(a.rolesOf("ws_b", "u-staff-a")).toBeNull();
    expect(svc.capabilitiesOf(ownerA).sort()).toEqual(["approve", "edit", "view"]);
    expect(svc.capabilitiesOf(staffA).sort()).toEqual(["edit", "view"]);
  });
});

describe("workspace isolation", () => {
  it("an admin of another workspace cannot read, approve, retire, preview or use a clause", () => {
    const id = newClause();
    svc.submitVersion(staffA, id, 1);
    expect(ok<unknown>(svc.getClause(adminB, id))).toBeNull();
    expect(code(svc.approveVersion(adminB, id, 1))).toBe("not_found");
    svc.approveVersion(adminA, id, 1);
    expect(code(svc.retireVersion(adminB, id, 1))).toBe("not_found");
    expect(code(svc.previewVersion(adminB, id, 1, VALUES))).toBe("not_found");
    expect(code(svc.renderApproved(adminB, id, 1, VALUES))).toBe("not_found");
    expect(ok<{ id: string }[]>(svc.listClauses(adminB)).map((c) => c.id)).not.toContain(id);
    expect(svc.approvedClausePicks(adminB)).toEqual([]);
  });
});

describe("the library rules hold in the app", () => {
  it("retiring the newest approved version never brings older text back", () => {
    const id = newClause(staffA, "Two versions");
    svc.submitVersion(staffA, id, 1);
    svc.approveVersion(adminA, id, 1);
    ok(svc.addVersion(staffA, id, "Pay {{fee:money}} promptly.", { kind: "negotiated" }));
    svc.submitVersion(staffA, id, 2);
    svc.approveVersion(adminA, id, 2);
    expect(code(svc.renderApproved(staffA, id, 1, VALUES))).toBe("superseded");
    svc.retireVersion(adminA, id, 2, "withdrawn");
    expect(code(svc.renderApproved(staffA, id, 1, VALUES))).toBe("superseded");
    expect(ok<unknown>(svc.latestApproved(staffA, id))).toBeNull();
  });
  it("preview renders any readable version with sample values and refuses unsafe ones", () => {
    const id = newClause(staffA, "Preview me");
    expect(ok<string>(svc.previewVersion(staffA, id, 1, VALUES))).toContain("$1,500.00");
    expect(code(svc.previewVersion(staffA, id, 1, { ...VALUES, "client.name": "<script>x</script>" }))).toBe("invalid_params");
    expect(code(svc.renderApproved(staffA, id, 1, VALUES))).toBe("not_approved");
  });
  it("sources are structured; free text claiming approval is refused", () => {
    expect(svc.sourceFrom("firm_template", "tpl-9")).toEqual({ kind: "firm_template", ref: "TPL-9" });
    expect(svc.sourceFrom("approved_by_gc", "")).toBeNull();
    expect(code(svc.createClause(staffA, { title: "T", kind: "fees", body: "x", source: null }))).toBe("bad_source");
    expect(code(svc.createClause(staffA, { title: "T", kind: "fees", body: "x", source: { kind: "firm_template", ref: "Approved by GC" } }))).toBe("bad_source");
  });
  it("clause ids come from the title and never collide", () => {
    expect(svc.clauseIdFor("Payment Terms (2026)!", () => "ab12cd")).toBe("payment-terms-2026-ab12cd");
    expect(svc.clauseIdFor("123 start", () => "zz")).toBe("c-123-start-zz");
    expect(svc.clauseIdFor("\u00e9\u00e9", () => "q")).toMatch(/^[a-z][a-z0-9-]{2,63}$/);
  });
});

describe("server actions: the session decides, forged form fields do not", () => {
  it("create, submit and approve through the actions; ids, roles and workspaces in the form are ignored", async () => {
    session.current = staffA;
    const url = await redirected(() => act.createClauseAction(fd({ title: "Action clause", kind: "fees", body: "Fee {{fee:money}}.", sourceKind: "firm_template", sourceRef: "", role: "owner", workspaceId: "ws_b", userId: "u-admin-b" })));
    const id = decodeURIComponent(url.match(/^\/app\/clauses\/([^?]+)\?ok=created$/)![1]);
    expect(ok<{ workspaceId: string; createdBy: string }>(svc.getClause(staffA, id))).toMatchObject({ workspaceId: "ws_a", createdBy: "u-staff-a" });
    expect(await redirected(() => act.submitClauseAction(fd({ id, n: "1" })))).toBe(`/app/clauses/${id}?ok=submitted`);
    // staff forging an approver role in the form is still staff
    expect(await redirected(() => act.approveClauseAction(fd({ id, n: "1", role: "owner", roles: "approver" })))).toBe(`/app/clauses/${id}?error=forbidden`);
    session.current = adminA;
    expect(await redirected(() => act.approveClauseAction(fd({ id, n: "1" })))).toBe(`/app/clauses/${id}?ok=approved`);
  });
  it("an admin of another workspace cannot approve, retire or version a clause through the actions", async () => {
    const id = newClause(staffA, "Tenant clause");
    svc.submitVersion(staffA, id, 1);
    session.current = adminB;
    expect(await redirected(() => act.approveClauseAction(fd({ id, n: "1", workspaceId: "ws_a" })))).toMatch(/\?error=not_found/);
    expect(await redirected(() => act.retireClauseAction(fd({ id, n: "1" })))).toMatch(/\?error=not_found/);
    expect(await redirected(() => act.addVersionAction(fd({ id, body: "x", sourceKind: "firm_template" })))).toMatch(/\?error=not_found/);
    expect(ok<{ versions: { state: string }[] }>(svc.getClause(staffA, id)).versions[0].state).toBe("in_review");
  });
  it("an author cannot approve their own clause through the actions", async () => {
    session.current = ownerA;
    const url = await redirected(() => act.createClauseAction(fd({ title: "Mine", kind: "fees", body: "Fee.", sourceKind: "precedent" })));
    const id = decodeURIComponent(url.match(/^\/app\/clauses\/([^?]+)\?/)![1]);
    await redirected(() => act.submitClauseAction(fd({ id, n: "1" })));
    expect(await redirected(() => act.approveClauseAction(fd({ id, n: "1" })))).toMatch(/\?error=self_approval/);
  });
  it("bad input is refused with a message, never an exception", async () => {
    session.current = staffA;
    expect(await redirected(() => act.createClauseAction(fd({ title: "Bad", kind: "fees", body: "<b>x</b>", sourceKind: "firm_template" })))).toBe("/app/clauses?error=invalid_body&issue=unsafe_html");
    expect(await redirected(() => act.createClauseAction(fd({ title: "Bad", kind: "fees", body: "x", sourceKind: "Approved by GC" })))).toMatch(/error=bad_source/);
    expect(await redirected(() => act.submitClauseAction(fd({ id: "nope-nope", n: "x" })))).toMatch(/error=not_found/);
  });
});

describe("Agreement Studio insert: approved, current text only, rendered with the member's values", () => {
  it("renders an approved clause, refuses drafts, other workspaces, unknown and prototype keys", async () => {
    const id = newClause(staffA, "Studio insert");
    session.current = staffA;
    expect(await act.renderApprovedClauseAction(id, 1, { "client.name": "Example Client LLC", fee: "1500", days: "30" })).toMatchObject({ ok: false });
    svc.submitVersion(staffA, id, 1);
    svc.approveVersion(adminA, id, 1);
    expect(await act.renderApprovedClauseAction(id, 1, { "client.name": "Example Client LLC", fee: "1500", days: "30" })).toEqual({
      ok: true, title: "Studio insert", text: "Example Client LLC shall pay $1,500.00 within 30 days of the invoice date.",
    });
    expect(await act.renderApprovedClauseAction(id, 1, JSON.parse('{"client.name":"A","fee":"1","days":"2","__proto__":"x"}'))).toMatchObject({ ok: false });
    expect(await act.renderApprovedClauseAction(id, 1, { "client.name": "<b>x</b>", fee: "1", days: "2" })).toMatchObject({ ok: false });
    session.current = adminB;
    expect(await act.renderApprovedClauseAction(id, 1, { "client.name": "A", fee: "1", days: "2" })).toEqual({ ok: false, message: "That clause or version doesn't exist in this workspace." });
    expect(svc.approvedClausePicks(staffA).find((x) => x.id === id)).toEqual({ id, title: "Studio insert", version: 1, placeholders: [{ path: "client.name", type: "text" }, { path: "fee", type: "money" }, { path: "days", type: "int" }] });
  });
});

describe("review of #64: audit trail, throttle, fixed messages, provenance", () => {
  const events = (clauseId: string) =>
    db.all<{ type: string; actor: string; ip: string | null; data_json: string }>("SELECT type, actor, ip, data_json FROM audit_events WHERE workspace_id = 'ws_a' AND data_json LIKE ? ORDER BY seq", `%"clauseId":"${clauseId}"%`);
  it("create, submit, approve, send back and retire are written to audit_events with the actor and request context", async () => {
    session.current = staffA;
    const url = await redirected(() => act.createClauseAction(fd({ title: "Audited", kind: "fees", body: "Fee {{fee:money}}.", sourceKind: "precedent" })));
    const id = decodeURIComponent(url.match(/^\/app\/clauses\/([^?]+)\?/)![1]);
    await redirected(() => act.submitClauseAction(fd({ id, n: "1" })));
    session.current = adminA;
    await redirected(() => act.sendBackClauseAction(fd({ id, n: "1", note: "clearer please" })));
    session.current = staffA;
    await redirected(() => act.submitClauseAction(fd({ id, n: "1" })));
    session.current = adminA;
    await redirected(() => act.approveClauseAction(fd({ id, n: "1" })));
    await redirected(() => act.retireClauseAction(fd({ id, n: "1" })));
    const ev = events(id);
    expect(ev.map((e) => [e.type, e.actor])).toEqual([
      ["clause.created", "u-staff-a@example.com"], ["clause.submitted", "u-staff-a@example.com"], ["clause.sent_back", "u-admin-a@example.com"],
      ["clause.submitted", "u-staff-a@example.com"], ["clause.approved", "u-admin-a@example.com"], ["clause.retired", "u-admin-a@example.com"],
    ]);
    expect(ev.every((e) => e.ip === "203.0.113.9")).toBe(true);
    expect(JSON.parse(ev[4].data_json)).toEqual({ clauseId: id, version: 1, userId: "u-admin-a" });
    // refused actions write nothing
    session.current = staffA;
    await redirected(() => act.approveClauseAction(fd({ id, n: "1" })));
    expect(events(id)).toHaveLength(6);
  });
  it("a change and its audit entry commit together: if the audit insert fails, the approval is rolled back", () => {
    const id = newClause(staffA, "Atomic");
    svc.submitVersion(staffA, id, 1);
    db.run("CREATE TRIGGER clause_test_fail BEFORE INSERT ON audit_events WHEN NEW.type = 'clause.approved' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      expect(() => svc.approveVersion(adminA, id, 1)).toThrow(/audit down/);
    } finally {
      db.run("DROP TRIGGER clause_test_fail");
    }
    expect(ok<{ versions: { state: string }[] }>(svc.getClause(staffA, id)).versions[0].state).toBe("in_review");
    expect(code(svc.approveVersion(adminA, id, 1))).toBe("ok");
  });
  it("clause writes are throttled per workspace", () => {
    const at = new Date().toISOString();
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_c','C','C LLC','C','Avery','avery-c@example.com','inb_ws_c',?)", at);
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u-staff-c','c@example.com','C','x',?)", at);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_c','u-staff-c','staff',?)", at);
    const staffC = S("u-staff-c", "ws_c", "staff");
    const results = Array.from({ length: svc.CLAUSE_WRITES_PER_MINUTE + 1 }, (_, i) => code(svc.createClause(staffC, { title: `Bulk ${i}`, kind: "other", body: "x", source: { kind: "imported" } })));
    expect(results.slice(0, svc.CLAUSE_WRITES_PER_MINUTE).every((c) => c === "ok")).toBe(true);
    expect(results.at(-1)).toBe("throttled");
    expect(code(svc.createClause(staffA, { title: "Other workspace is not throttled", kind: "other", body: "x", source: { kind: "imported" } }))).toBe("ok");
  });
  it("failure text is fixed per code; nothing from the URL or an error message is shown", async () => {
    const { failureText, failureCodes } = await import("../../lib/clauses/app/messages");
    expect(failureText("forbidden")).toBe("You don't have permission to do that.");
    expect(failureText("<script>alert(1)</script>", "unsafe_html")).toBe("That didn't work. Try again. It contains markup or an HTML tag.");
    expect(failureText("forbidden", "Your account is locked, call 555")).toBe("You don't have permission to do that.");
    expect(failureText("__proto__", "constructor")).toBe("That didn't work. Try again.");
    expect(failureCodes({ code: "made-up", issues: [{ code: "also made-up" }] })).toEqual({ error: "failed" });
    const r = svc.createClause(staffA, { title: "T", kind: "fees", body: "<b>x</b>", source: { kind: "firm_template" } });
    expect(r).toMatchObject({ ok: false, code: "invalid_body", issues: ["unsafe_html"], message: "The clause text isn't valid. It contains markup or an HTML tag." });
  });
  it("a failed ROLLBACK does not hide the error that caused it", async () => {
    const { SqliteClauseStore } = await import("../../lib/clauses");
    const { TestAuth } = await import("./helpers");
    const conn = {
      prepare: (sql: string) => ({ all: () => (/table_info/.test(sql) ? [{ name: "workspace_id" }] : []), get: () => undefined, run: () => ({}) }),
      exec: (sql: string) => { if (sql === "ROLLBACK") throw new Error("cannot rollback"); },
      isTransaction: false,
    };
    const store = new SqliteClauseStore(conn as never, { authorizer: new TestAuth() });
    // inside the transaction the clause is missing (not_found); the ROLLBACK then fails, and the caller still sees not_found
    expect(() => store.saveVersion("ws-a", "missing-one", {} as never)).toThrow(/^No clause missing-one$/);
  });
  it("Agreement Studio records library provenance only when the added text is exactly the approved clause", async () => {
    const drafts = await import("../../lib/drafts/service");
    const id = newClause(staffA, "Provenance clause");
    svc.submitVersion(staffA, id, 1);
    svc.approveVersion(adminA, id, 1);
    const values = { "client.name": "Acme Widgets Inc", fee: "900", days: "14" };
    const text = ok<string>(svc.renderApproved(staffA, id, 1, values));
    const c = await drafts.createDraft(ownerA, {
      kind: "nda", parties: [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "Acme Widgets Inc" }],
      terms: { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Delaware" },
    });
    expect(c, JSON.stringify(c)).toMatchObject({ ok: true });
    const draftId = (c as { draftId: string }).draftId;
    const g = drafts.getDraft(staffA, draftId);
    if (!g.ok) throw new Error("no draft");
    // after the last unlocked clause, so no later "clause N" reference has to be renumbered
    const after = (g.version.doc as { clauses: { id: string; locked?: boolean }[] }).clauses.filter((x) => !x.locked).at(-1)!.id;
    // edited after filling: refused as a library insert
    expect(drafts.editDraft(staffA, draftId, 1, { op: "add_clause", after, text: text + " Changed.", library: { id, version: 1, values } })).toMatchObject({ ok: false, code: "invalid" });
    // a forged reference to a clause in another workspace or a draft version is refused too
    expect(drafts.editDraft(adminB, draftId, 1, { op: "add_clause", after, text, library: { id, version: 1, values } }).ok).toBe(false);
    const r = drafts.editDraft(staffA, draftId, 1, { op: "add_clause", after, text, heading: "Payment", library: { id, version: 1, values } });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const row = db.one<{ rationale: string; status: string; after_text: string; created_by: string }>("SELECT rationale, status, after_text, created_by FROM draft_proposals WHERE draft_id = ? AND workspace_id = 'ws_a'", draftId)!;
    expect(row).toEqual({ rationale: `added from the Clause Library: Provenance clause (${id} v1)`, status: "accepted", after_text: text, created_by: "u-staff-a" });
    expect(events(id).map((e) => e.type)).toContain("clause.used");
  });
});

