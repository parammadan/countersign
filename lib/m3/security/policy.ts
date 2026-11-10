import type { DocumentRef, Role, User, Workspace } from "./types";

const RANK: Record<Role, number> = { viewer: 1, staff: 2, admin: 3, owner: 4 };

function rank(role: unknown): number {
  return typeof role === "string" && Object.prototype.hasOwnProperty.call(RANK, role) ? RANK[role as Role] : 0;
}

/** The user's role in the workspace; the lowest one if memberships are duplicated; 0 if none or unknown. */
export function roleRank(user: User, workspaceId: string): number {
  let best = 0;
  let seen = false;
  const ms: unknown = user.memberships;
  for (const m of Array.isArray(ms) ? (ms as User["memberships"]) : []) {
    if (m?.workspaceId !== workspaceId) continue;
    const r = rank(m.role);
    best = seen ? Math.min(best, r) : r;
    seen = true;
  }
  return best;
}

export type Decision = { allowed: boolean; reason: string };

/** Default deny. Every allow path requires: membership in `workspace`, the document inside the same workspace. */
export function decideRead(user: User, workspace: Workspace, document: DocumentRef): Decision {
  const deny = (reason: string): Decision => ({ allowed: false, reason });
  if (!user || typeof user.id !== "string" || !workspace || typeof workspace.id !== "string" || !document) return deny("malformed-input");
  if (user.disabled) return deny("user-disabled");
  const r = roleRank(user, workspace.id);
  if (r === 0) return deny("not-a-member");
  if (document.workspaceId !== workspace.id) return deny("cross-workspace");
  if (document.status === "deleted") return deny("deleted");
  if (document.status === "superseded" && r < RANK.admin) return deny("superseded-admin-only");
  if (document.status !== "active" && document.status !== "superseded") return deny("unknown-status");
  const res = document.restrictions;
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  // Fail closed on any malformed restriction value (non-object, null, array, non-array lists, unknown minRole), owners included.
  if (res !== undefined) {
    if (res === null || typeof res !== "object" || Array.isArray(res)) return deny("malformed-restrictions");
    if ((res.allowUserIds !== undefined && !Array.isArray(res.allowUserIds)) || (res.denyUserIds !== undefined && !Array.isArray(res.denyUserIds))) return deny("malformed-restrictions");
    if (res.minRole !== undefined && rank(res.minRole) === 0) return deny("unknown-min-role");
  }
  if (list(res?.denyUserIds).includes(user.id)) return deny("explicit-deny");
  if (r === RANK.owner) return { allowed: true, reason: "owner" };
  if (list(res?.allowUserIds).includes(user.id)) return { allowed: true, reason: "allow-list" };
  const need = res?.minRole === undefined ? RANK.viewer : rank(res.minRole);
  if (need === 0) return deny("unknown-min-role");
  return r >= need ? { allowed: true, reason: "role" } : deny("below-min-role");
}

export function canRead(user: User, workspace: Workspace, document: DocumentRef): boolean {
  return decideRead(user, workspace, document).allowed;
}
