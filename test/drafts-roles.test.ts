import { describe, expect, it } from "vitest";
import { authorizeDraft, editorRoleFor, principalFrom, type DraftAction, type MemberRole, type Principal } from "@/lib/drafts/roles";

const who = (role: MemberRole, userId = `u-${role}`, workspaceId = "ws-a"): Principal => ({ userId, workspaceId, role });
const draftA = { workspaceId: "ws-a", lastEditor: "u-editor-other" };
const code = (r: ReturnType<typeof authorizeDraft>) => (r.ok ? "ok" : r.code);

describe("role mapping (owner decision)", () => {
  const table: [MemberRole, DraftAction, string][] = [
    ["owner", "view", "ok"], ["owner", "edit", "ok"], ["owner", "approve", "ok"], ["owner", "publish", "ok"],
    ["admin", "view", "ok"], ["admin", "edit", "ok"], ["admin", "approve", "ok"], ["admin", "publish", "ok"],
    ["staff", "view", "ok"], ["staff", "edit", "ok"], ["staff", "approve", "forbidden"], ["staff", "publish", "forbidden"],
  ];
  for (const [role, action, want] of table) {
    it(`${role} ${action}: ${want}`, () => expect(code(authorizeDraft(who(role), draftA, action))).toBe(want));
  }
  it("editing never implies approval: staff who can edit is refused approve and publish", () => {
    const staff = who("staff");
    expect(code(authorizeDraft(staff, draftA, "edit"))).toBe("ok");
    expect(code(authorizeDraft(staff, draftA, "approve"))).toBe("forbidden");
    expect(code(authorizeDraft(staff, draftA, "publish"))).toBe("forbidden");
  });
  it("maps to the sandbox editor role: owner/admin approve, staff edits", () => {
    expect(editorRoleFor("owner")).toBe("approver");
    expect(editorRoleFor("admin")).toBe("approver");
    expect(editorRoleFor("staff")).toBe("editor");
    const r = authorizeDraft(who("staff"), draftA, "edit");
    expect(r.ok && r.editorRole).toBe("editor");
  });
});

describe("cross-tenant", () => {
  for (const action of ["view", "edit", "approve", "publish"] as const) {
    for (const role of ["owner", "admin", "staff"] as const) {
      it(`${role} of workspace B cannot ${action} a workspace A draft, and is told not_found`, () => {
        const r = authorizeDraft(who(role, `u-${role}`, "ws-b"), draftA, action);
        expect(code(r)).toBe("not_found");
        expect(r.ok === false && r.message).toBe("Draft not found.");
      });
    }
  }
  it("a missing draft and another workspace's draft give the same answer", () => {
    const other = authorizeDraft(who("owner", "u", "ws-b"), draftA, "view");
    const missing = authorizeDraft(who("owner", "u", "ws-b"), null, "view");
    expect(other).toEqual(missing);
  });
  it("a draft row with no workspace is not found", () => {
    expect(code(authorizeDraft(who("owner"), { workspaceId: "" }, "view"))).toBe("not_found");
    expect(code(authorizeDraft(who("owner"), { workspaceId: undefined as unknown as string }, "view"))).toBe("not_found");
  });
});

describe("approval needs a different person", () => {
  it("the last editor cannot approve their own draft, even as owner", () => {
    expect(code(authorizeDraft(who("owner", "u1"), { workspaceId: "ws-a", lastEditor: "u1" }, "approve"))).toBe("same_person");
  });
  it("an unknown last editor is refused", () => {
    expect(code(authorizeDraft(who("owner"), { workspaceId: "ws-a" }, "approve"))).toBe("same_person");
  });
  it("can be turned off explicitly", () => {
    expect(code(authorizeDraft(who("owner", "u1"), { workspaceId: "ws-a", lastEditor: "u1" }, "approve", { requireDistinctApprover: false }))).toBe("ok");
  });
  it("does not apply to edit or publish", () => {
    expect(code(authorizeDraft(who("admin", "u1"), { workspaceId: "ws-a", lastEditor: "u1" }, "edit"))).toBe("ok");
    expect(code(authorizeDraft(who("admin", "u1"), { workspaceId: "ws-a", lastEditor: "u1" }, "publish"))).toBe("ok");
  });
});

describe("fail closed on bad input", () => {
  it("no session, or a malformed one, is unauthenticated", () => {
    expect(code(authorizeDraft(null, draftA, "view"))).toBe("unauthenticated");
    for (const bad of [{}, { userId: "u", workspaceId: "ws-a" }, { userId: "", workspaceId: "ws-a", role: "owner" }, { userId: "u", workspaceId: " ", role: "owner" }]) {
      expect(code(authorizeDraft(bad as Principal, draftA, "view"))).toBe("unauthenticated");
    }
  });
  it("roles outside owner/admin/staff are refused, including a request-supplied 'approver'", () => {
    for (const role of ["approver", "editor", "viewer", "Owner", "ADMIN", "superuser", "", "__proto__"]) {
      expect(code(authorizeDraft({ userId: "u", workspaceId: "ws-a", role } as unknown as Principal, draftA, "approve"))).toBe("unauthenticated");
    }
  });
  it("unknown actions are refused", () => {
    for (const a of ["delete", "", "constructor", "toString"]) {
      expect(code(authorizeDraft(who("owner"), draftA, a as DraftAction))).toBe("forbidden");
    }
  });
  it("principalFrom copies only userId, workspaceId and role, frozen", () => {
    const p = principalFrom({ userId: "u", workspaceId: "ws-a", role: "staff", isAdmin: true, approver: true, userEmail: "x@example.com" });
    expect(p).toEqual({ userId: "u", workspaceId: "ws-a", role: "staff" });
    expect(Object.isFrozen(p)).toBe(true);
    expect(code(authorizeDraft(p, draftA, "approve"))).toBe("forbidden");
  });
  it("inherited fields are not trusted", () => {
    const s = Object.assign(Object.create({ role: "owner" }), { userId: "u", workspaceId: "ws-a" });
    expect(code(authorizeDraft(s, draftA, "view"))).toBe("unauthenticated");
    const t = Object.assign(Object.create({ approver: true }), { userId: "u", workspaceId: "ws-a", role: "staff" });
    expect(code(authorizeDraft(t, draftA, "approve"))).toBe("forbidden");
  });
});
