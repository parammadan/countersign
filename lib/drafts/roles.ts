// Server-side authorization for M2.3 drafts (owner decision, 2026-11-09). Nothing calls it yet.
//
// Production has three member roles (owner, admin, staff). The M2.3 editor speaks in capabilities:
//   view    -> owner, admin, staff   (staff is read-and-edit; there is no read-only member role today)
//   edit    -> owner, admin, staff   (propose, accept and commit edits; submit for approval)
//   approve -> owner, admin only     (approve, request changes)
//   publish -> owner, admin only     (stricter than the sandbox, where editors could publish an approved version)
// Editing never implies approval: the two are separate checks and staff can never approve.
//
// Rules every caller must follow:
// - The principal comes from getSession() on the server, never from request input (form fields, JSON, headers).
//   `principalFrom` copies only the fields it needs, so a role or workspace in the request has no way in.
// - The draft's workspace comes from the database row, never from request input.
// - A draft in another workspace is reported as `not_found`, the same as a missing draft, so ids cannot be probed.
// - Approval always needs someone who is neither the last editor nor the author of any version (no option).
// Unknown roles, missing fields and wrong types all deny (fail closed).

export type MemberRole = "owner" | "admin" | "staff";
export type DraftAction = "view" | "edit" | "approve" | "request_changes" | "publish";

/** The authenticated member, as getSession() returns it. */
export type Principal = { readonly userId: string; readonly workspaceId: string; readonly role: MemberRole };
/** What the database says about the draft being acted on. */
/** `authors`: every user who created or saved a version of the draft (none of them may approve it). */
export type DraftScope = { readonly workspaceId: string; readonly lastEditor?: string; readonly authors?: readonly string[] };

export type AuthzResult =
  | { ok: true; editorRole: "editor" | "approver" }
  | { ok: false; code: "unauthenticated" | "not_found" | "forbidden" | "same_person"; message: string };

const CAN: Readonly<Record<DraftAction, readonly MemberRole[]>> = Object.freeze({
  view: Object.freeze(["owner", "admin", "staff"] as const),
  edit: Object.freeze(["owner", "admin", "staff"] as const),
  approve: Object.freeze(["owner", "admin"] as const),
  request_changes: Object.freeze(["owner", "admin"] as const),
  publish: Object.freeze(["owner", "admin"] as const),
});
const ROLES: readonly string[] = ["owner", "admin", "staff"];
const ACTIONS: readonly string[] = ["view", "edit", "approve", "request_changes", "publish"];

const deny = (code: Exclude<AuthzResult, { ok: true }>["code"], message: string): AuthzResult => ({ ok: false, code, message });
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Copies the three fields this module uses from a server session; anything malformed gives null. */
export function principalFrom(session: unknown): Principal | null {
  if (typeof session !== "object" || session === null) return null;
  // own properties only: nothing inherited from a prototype counts
  if (!["userId", "workspaceId", "role"].every((k) => Object.prototype.hasOwnProperty.call(session, k))) return null;
  const { userId, workspaceId, role } = session as Record<string, unknown>;
  if (!nonEmpty(userId) || !nonEmpty(workspaceId) || typeof role !== "string" || !ROLES.includes(role)) return null;
  return Object.freeze({ userId, workspaceId, role: role as MemberRole });
}

/** The sandbox editor's role for this member: owner and admin approve, staff edits. */
export function editorRoleFor(role: MemberRole): "editor" | "approver" {
  return role === "owner" || role === "admin" ? "approver" : "editor";
}

/**
 * May this member perform `action` on this draft? Deny by default. "approve" always requires someone who is neither
 * the last editor nor the author of any version (owner rule; there is no option to turn it off). "request_changes"
 * (sending a submitted draft back) needs an approver role but approves nothing, so the last editor may do it.
 */
export function authorizeDraft(principal: Principal | null, draft: DraftScope | null, action: DraftAction): AuthzResult {
  const p = principalFrom(principal);
  if (!p) return deny("unauthenticated", "Sign in to continue.");
  if (typeof action !== "string" || !ACTIONS.includes(action)) return deny("forbidden", "Unknown action.");
  if (!draft || typeof draft !== "object" || !nonEmpty(draft.workspaceId) || draft.workspaceId !== p.workspaceId)
    return deny("not_found", "Draft not found.");
  if (!CAN[action].includes(p.role)) return deny("forbidden", action === "approve" || action === "request_changes" || action === "publish" ? "Only an owner or admin can do this." : "You can't do this.");
  if (action === "approve") {
    if (!nonEmpty(draft.lastEditor)) return deny("same_person", "The last editor of this draft is unknown, so it can't be approved yet.");
    if (draft.lastEditor === p.userId) return deny("same_person", "Someone other than the last editor must approve this draft.");
    if (!Array.isArray(draft.authors)) return deny("same_person", "The authors of this draft are unknown, so it can't be approved yet.");
    if (draft.authors.includes(p.userId)) return deny("same_person", "You created or edited a version of this draft, so someone else must approve it.");
  }
  return { ok: true, editorRole: editorRoleFor(p.role) };
}
