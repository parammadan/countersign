// Clause library inside the app: binds lib/clauses to the signed-in member and to countersign.db.
//
// - The principal comes from the server session only (requireSession()), never from request input. `principalOf`
//   copies the three fields it needs, so nothing else in the session or the request reaches the library.
// - Roles come from clauseRolesForMember(session.role): owner/admin = viewer + editor + approver, staff = viewer +
//   editor. Editing never implies approval, and the library refuses an author approving their own version.
// - The authorizer answers only for the signed-in user in the session's workspace; any other user id or workspace
//   gets no roles (fail closed). Every store call is scoped to the session's workspace, so another workspace's clause
//   is simply "not found".
// - Tables are created at first use (CREATE ... IF NOT EXISTS on the app connection; no pragma). The owner's
//   migration patch is docs/owner-patches/clause-library-migration.patch.
import type { DatabaseSync } from "node:sqlite";
import { all, db } from "../../db";
import {
  ClauseError, ClauseLibrary, SqliteClauseStore, SOURCE_KINDS, clauseRolesForMember, renderVersion,
  type Actor, type Capability, type Clause, type ClauseAuthorizer, type ClauseKind, type ClauseSource, type ClauseVersion,
  type Params, type SourceKind,
} from "..";

export type MemberRole = "owner" | "admin" | "staff";
export type Principal = { readonly userId: string; readonly workspaceId: string; readonly role: MemberRole };
export type Result<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Copies userId, workspaceId and role from a server session; anything malformed gives null. */
export function principalOf(session: unknown): Principal | null {
  if (typeof session !== "object" || session === null) return null;
  const s = session as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 128;
  if (!ok(s.userId) || !ok(s.workspaceId) || (s.role !== "owner" && s.role !== "admin" && s.role !== "staff")) return null;
  return Object.freeze({ userId: s.userId, workspaceId: s.workspaceId, role: s.role });
}

/** The host authorizer for one request: the signed-in member's roles, nobody else's. */
export function authorizerFor(p: Principal): ClauseAuthorizer {
  return Object.freeze({
    rolesOf: (workspaceId: string, userId: string) => (workspaceId === p.workspaceId && userId === p.userId ? clauseRolesForMember(p.role) : null),
  });
}

export function capabilitiesOf(session: unknown): Capability[] {
  const p = principalOf(session);
  if (!p) return [];
  const roles = clauseRolesForMember(p.role);
  return [...new Set(roles.flatMap((r) => (r === "viewer" ? ["view"] : r === "editor" ? ["view", "edit"] : ["view", "approve"])))] as Capability[];
}

function bind(session: unknown, conn: DatabaseSync = db()): { lib: ClauseLibrary; actor: Actor } | null {
  const p = principalOf(session);
  if (!p) return null;
  const auth = authorizerFor(p);
  const lib = new ClauseLibrary(new SqliteClauseStore(conn, { authorizer: auth }), auth);
  return { lib, actor: { workspaceId: p.workspaceId, id: p.userId } };
}

function run<T>(session: unknown, fn: (lib: ClauseLibrary, actor: Actor) => T): Result<{ value: T }> {
  const b = bind(session);
  if (!b) return { ok: false, code: "unauthenticated", message: "Sign in again." };
  try {
    return { ok: true, value: fn(b.lib, b.actor) };
  } catch (e) {
    if (e instanceof ClauseError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

export const CLAUSE_KIND_LABEL: Record<ClauseKind, string> = {
  confidentiality: "Confidentiality", fees: "Fees", payment: "Payment", scope: "Scope", term: "Term",
  termination: "Termination", liability: "Liability", general: "General", other: "Other",
};
export const STATE_LABEL: Record<ClauseVersion["state"], string> = { draft: "Draft", in_review: "In review", approved: "Approved", retired: "Retired" };
export const STATE_TONE: Record<ClauseVersion["state"], "neutral" | "warn" | "ok" | "bad"> = { draft: "neutral", in_review: "warn", approved: "ok", retired: "bad" };
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  firm_template: "Firm template", precedent: "Precedent", negotiated: "Negotiated", new_drafting: "New drafting", imported: "Imported",
};

/** A clause id from its title: lowercase words and a short random suffix, so two titles never collide. */
export function clauseIdFor(title: string, rand: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "clause";
  const id = `${/^[a-z]/.test(base) ? base : `c-${base}`}-${rand().replace(/[^a-z0-9]/g, "").slice(0, 8) || "x"}`;
  return id.slice(0, 64);
}

export function sourceFrom(kind: unknown, ref: unknown): ClauseSource | null {
  if (typeof kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(kind)) return null;
  const r = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  return r ? { kind: kind as SourceKind, ref: r } : { kind: kind as SourceKind };
}

export const listClauses = (s: unknown) => run(s, (lib, a) => lib.list(a));
export const getClause = (s: unknown, id: string) => run(s, (lib, a) => lib.get(id, a));

export function createClause(s: unknown, input: { title: string; kind: string; body: string; source: ClauseSource | null }): Result<{ value: Clause }> {
  if (!input.source) return { ok: false, code: "bad_source", message: "Choose where the text comes from." };
  const source = input.source;
  return run(s, (lib, a) => lib.createClause({ id: clauseIdFor(input.title), kind: input.kind as ClauseKind, title: input.title, body: input.body, source }, a));
}

export function addVersion(s: unknown, id: string, body: string, source: ClauseSource | null): Result<{ value: ClauseVersion }> {
  if (!source) return { ok: false, code: "bad_source", message: "Choose where the text comes from." };
  return run(s, (lib, a) => lib.addVersion(id, body, source, a));
}

export const editDraft = (s: unknown, id: string, n: number, body: string) => run(s, (lib, a) => lib.editDraft(id, n, body, a));
export const submitVersion = (s: unknown, id: string, n: number) => run(s, (lib, a) => lib.submit(id, n, a));
export const approveVersion = (s: unknown, id: string, n: number) => run(s, (lib, a) => lib.approve(id, n, a));
export const sendBackVersion = (s: unknown, id: string, n: number, note?: string) => run(s, (lib, a) => lib.sendBack(id, n, a, note));
export const retireVersion = (s: unknown, id: string, n: number, note?: string) => run(s, (lib, a) => lib.retire(id, n, a, note));
export const latestApproved = (s: unknown, id: string) => run(s, (lib, a) => lib.latestApproved(id, a));

/** Preview any version the member can read, rendered with sample values (the approved-only gate is useApproved). */
export function previewVersion(s: unknown, id: string, n: number, params: Params): Result<{ value: string }> {
  return run(s, (lib, a) => {
    const c = lib.get(id, a);
    const v = c?.versions.find((x) => x.version === n);
    if (!v) throw new ClauseError("not_found", `No version ${n} of ${id}`);
    return renderVersion(v, params);
  });
}

/** Approved, current text rendered with the member's values: the only way clause text goes into an agreement. */
export const useApproved = (s: unknown, id: string, n: number, params: Params) => run(s, (lib, a) => lib.useInDraft(id, n, params, a));

/** Every approved, current clause in the workspace with its usable version (for pickers). */
export function approvedClauses(s: unknown): Result<{ value: { clause: Clause; version: ClauseVersion }[] }> {
  return run(s, (lib, a) =>
    lib.list(a).flatMap((c) => {
      const v = lib.latestApproved(c.id, a);
      return v ? [{ clause: c, version: v }] : [];
    }));
}

/** Display names of the members of the session's workspace (history shows names, not ids). */
export function memberNames(s: unknown): Map<string, string> {
  const p = principalOf(s);
  if (!p) return new Map();
  const rows = all<{ id: string; name: string }>("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?", p.workspaceId);
  return new Map(rows.map((r) => [r.id, r.name]));
}
