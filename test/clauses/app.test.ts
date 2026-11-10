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
    expect(ok<string>(svc.useApproved(staffA, id, 1, VALUES))).toBe("Example Client LLC shall pay $1,500.00 within 30 days of the invoice date.");
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
    expect(Object.keys(p).sort()).toEqual(["role", "userId", "workspaceId"]);
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
    expect(code(svc.useApproved(adminB, id, 1, VALUES))).toBe("not_found");
    expect(ok<{ id: string }[]>(svc.listClauses(adminB)).map((c) => c.id)).not.toContain(id);
    expect(ok<unknown[]>(svc.approvedClauses(adminB))).toEqual([]);
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
    expect(code(svc.useApproved(staffA, id, 1, VALUES))).toBe("superseded");
    svc.retireVersion(adminA, id, 2, "withdrawn");
    expect(code(svc.useApproved(staffA, id, 1, VALUES))).toBe("superseded");
    expect(ok<unknown>(svc.latestApproved(staffA, id))).toBeNull();
  });
  it("preview renders any readable version with sample values and refuses unsafe ones", () => {
    const id = newClause(staffA, "Preview me");
    expect(ok<string>(svc.previewVersion(staffA, id, 1, VALUES))).toContain("$1,500.00");
    expect(code(svc.previewVersion(staffA, id, 1, { ...VALUES, "client.name": "<script>x</script>" }))).toBe("invalid_params");
    expect(code(svc.useApproved(staffA, id, 1, VALUES))).toBe("not_approved");
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
    expect(await redirected(() => act.approveClauseAction(fd({ id, n: "1", role: "owner", roles: "approver" })))).toMatch(/\?error=forbidden&msg=/);
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
    expect(await redirected(() => act.createClauseAction(fd({ title: "Bad", kind: "fees", body: "<b>x</b>", sourceKind: "firm_template" })))).toMatch(/^\/app\/clauses\?error=invalid_body&msg=/);
    expect(await redirected(() => act.createClauseAction(fd({ title: "Bad", kind: "fees", body: "x", sourceKind: "Approved by GC" })))).toMatch(/error=bad_source/);
    expect(await redirected(() => act.submitClauseAction(fd({ id: "nope-nope", n: "x" })))).toMatch(/error=not_found/);
  });
});
