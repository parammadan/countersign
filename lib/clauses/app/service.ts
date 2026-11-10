// Clause library inside the app: binds lib/clauses to the signed-in member and to countersign.db.
//
// - The principal comes from the server session only (requireSession()), never from request input. `principalOf`
//   copies the fields it needs, so nothing else in the session or the request reaches the library.
// - Roles come from clauseRolesForMember(session.role): owner/admin = viewer + editor + approver, staff = viewer +
//   editor. Editing never implies approval, and the library refuses an author approving their own version.
// - The authorizer answers only for the signed-in user in the session's workspace; any other user id or workspace
//   gets no roles (fail closed). Every store call is scoped to the session's workspace, so another workspace's clause
//   is simply "not found".
// - Known limit (by design): the library compares user ids. One person with two accounts in the same workspace (for
//   example an owner who invites their own second address as admin) can approve their own text; nothing here can
//   tell. Both accounts are recorded, so it shows in the clause history and in audit_events (clause.submitted and
//   clause.approved carry the actor).
// - Every state change (create, new version, submit, approve, send back, retire) and every verified use in Agreement
//   Studio is written to audit_events in the same transaction as the change.
// - Tables are created at first use (CREATE ... IF NOT EXISTS on the app connection; no pragma). The owner's
//   migration patch is docs/owner-patches/clause-library-migration.patch.
// - Failures carry codes only; their text comes from ./messages (fixed strings), never from the request or an error.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../../audit";
import { all, db, tx } from "../../db";
import { limited } from "../../ratelimit";
import {
  ClauseError, ClauseLibrary, SqliteClauseStore, SOURCE_KINDS, clauseRolesForMember, renderVersion,
  type Actor, type Capability, type Clause, type ClauseAuthorizer, type ClauseKind, type ClauseSource, type ClauseVersion,
  type Params, type PlaceholderType, type SourceKind,
} from "..";
import { failureText } from "./messages";

export type MemberRole = "owner" | "admin" | "staff";
export type Principal = { readonly userId: string; readonly workspaceId: string; readonly role: MemberRole; readonly label: string };
export type Failure = { ok: false; code: string; issues: string[]; message: string };
export type Result<T> = ({ ok: true } & T) | Failure;
/** Request context for the audit trail (the action passes ctxFromHeaders()). */
export type AuditCtx = { ip?: string; ua?: string };

/** Clause writes (create and new version) per workspace per minute. */
export const CLAUSE_WRITES_PER_MINUTE = 30;

/** Copies userId, workspaceId, role (and the email, for the audit trail) from a server session; malformed gives null. */
export function principalOf(session: unknown): Principal | null {
  if (typeof session !== "object" || session === null) return null;
  const s = session as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 128;
  if (!ok(s.userId) || !ok(s.workspaceId) || (s.role !== "owner" && s.role !== "admin" && s.role !== "staff")) return null;
  const label = typeof s.userEmail === "string" && s.userEmail.length <= 320 ? s.userEmail : s.userId;
  return Object.freeze({ userId: s.userId, workspaceId: s.workspaceId, role: s.role, label });
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

const fail = (code: string, issues: string[] = []): Failure => ({ ok: false, code, issues, message: failureText(code, issues[0]) });

function bind(p: Principal, conn: DatabaseSync = db()): { lib: ClauseLibrary; actor: Actor } {
  const auth = authorizerFor(p);
  return { lib: new ClauseLibrary(new SqliteClauseStore(conn, { authorizer: auth }), auth), actor: { workspaceId: p.workspaceId, id: p.userId } };
}

/**
 * Runs one library call for the session. With `event`, the call and its audit_events row commit in one transaction
 * (the store's own transaction joins it), so a change is never recorded without its audit entry or the reverse.
 */
function run<T>(
  session: unknown,
  fn: (lib: ClauseLibrary, actor: Actor) => T,
  event?: { type: string; data: (v: T) => Record<string, unknown>; ctx?: AuditCtx },
): Result<{ value: T }> {
  const p = principalOf(session);
  if (!p) return fail("unauthenticated");
  try {
    const b = bind(p);
    if (!event) return { ok: true, value: fn(b.lib, b.actor) };
    const value = tx(() => {
      const v = fn(b.lib, b.actor);
      audit(p.workspaceId, null, event.type, p.label, event.ctx ?? {}, { ...event.data(v), userId: p.userId });
      return v;
    });
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ClauseError) return fail(e.code, e.issues.map((i) => i.code));
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

/** Per-workspace write throttle (create and new version): a member can't flood the library or the audit trail. */
function throttled(session: unknown): boolean {
  const p = principalOf(session);
  return !!p && limited(`clauses-write:${p.workspaceId}`, CLAUSE_WRITES_PER_MINUTE, 60_000);
}

export const listClauses = (s: unknown) => run(s, (lib, a) => lib.list(a));
export const getClause = (s: unknown, id: string) => run(s, (lib, a) => lib.get(id, a));

export function createClause(s: unknown, input: { title: string; kind: string; body: string; source: ClauseSource | null }, ctx?: AuditCtx): Result<{ value: Clause }> {
  if (!input.source) return fail("bad_source");
  if (throttled(s)) return fail("throttled");
  const source = input.source;
  return run(s, (lib, a) => lib.createClause({ id: clauseIdFor(input.title), kind: input.kind as ClauseKind, title: input.title, body: input.body, source }, a),
    { type: "clause.created", data: (c) => ({ clauseId: c.id, version: 1 }), ctx });
}

export function addVersion(s: unknown, id: string, body: string, source: ClauseSource | null, ctx?: AuditCtx): Result<{ value: ClauseVersion }> {
  if (!source) return fail("bad_source");
  if (throttled(s)) return fail("throttled");
  return run(s, (lib, a) => lib.addVersion(id, body, source, a), { type: "clause.version_added", data: (v) => ({ clauseId: id, version: v.version }), ctx });
}

const moved = (type: string, id: string, ctx?: AuditCtx) => ({ type, data: (v: ClauseVersion) => ({ clauseId: id, version: v.version }), ctx });
export const editDraft = (s: unknown, id: string, n: number, body: string) => run(s, (lib, a) => lib.editDraft(id, n, body, a));
export const submitVersion = (s: unknown, id: string, n: number, ctx?: AuditCtx) => run(s, (lib, a) => lib.submit(id, n, a), moved("clause.submitted", id, ctx));
export const approveVersion = (s: unknown, id: string, n: number, ctx?: AuditCtx) => run(s, (lib, a) => lib.approve(id, n, a), moved("clause.approved", id, ctx));
export const sendBackVersion = (s: unknown, id: string, n: number, note?: string, ctx?: AuditCtx) => run(s, (lib, a) => lib.sendBack(id, n, a, note), moved("clause.sent_back", id, ctx));
export const retireVersion = (s: unknown, id: string, n: number, note?: string, ctx?: AuditCtx) => run(s, (lib, a) => lib.retire(id, n, a, note), moved("clause.retired", id, ctx));
export const latestApproved = (s: unknown, id: string) => run(s, (lib, a) => lib.latestApproved(id, a));

/** Preview any version the member can read, rendered with sample values (the approved-only gate is renderApproved). */
export function previewVersion(s: unknown, id: string, n: number, params: Params): Result<{ value: string }> {
  return run(s, (lib, a) => {
    const c = lib.get(id, a);
    const v = c?.versions.find((x) => x.version === n);
    if (!v) throw new ClauseError("not_found", `No version ${n} of ${id}`);
    return renderVersion(v, params);
  });
}

/**
 * Approved, current text rendered with the member's values (the library's useInDraft gate: draft, in-review, retired
 * and superseded text is refused). Agreement Studio fills its add-clause box with it; the member may still edit that
 * text before adding it, in which case the clause is an ordinary edit and no library provenance is recorded (see
 * verifyLibraryUse).
 */
export const renderApproved = (s: unknown, id: string, n: number, params: Params) => run(s, (lib, a) => lib.useInDraft(id, n, params, a));

/**
 * Server-side check behind the provenance Agreement Studio records: the text being added is exactly the approved,
 * current version of the clause rendered with these values. Returns the clause title for the rationale.
 */
export function verifyLibraryUse(s: unknown, ref: { id: string; version: number; values: Params }, text: string): Result<{ value: { title: string } }> {
  const r = renderApproved(s, ref.id, ref.version, ref.values);
  if (!r.ok) return r;
  if (r.value !== text) return fail("invalid_params");
  const c = getClause(s, ref.id);
  return c.ok && c.value ? { ok: true, value: { title: c.value.title } } : fail("not_found");
}

/** Records a verified library use in audit_events (called inside the Studio's own commit transaction). */
export function auditLibraryUse(s: unknown, ref: { id: string; version: number }, draft: { id: string; version: number }) {
  const p = principalOf(s);
  if (p) audit(p.workspaceId, null, "clause.used", p.label, {}, { clauseId: ref.id, version: ref.version, draftId: draft.id, draftVersion: draft.version, userId: p.userId });
}

export type LibraryPick = { id: string; title: string; version: number; placeholders: { path: string; type: PlaceholderType }[] };

/**
 * The usable clause of every library entry in the session's workspace, for Agreement Studio's picker: one query,
 * only id, title, version number and placeholder list (no bodies or history). Usable = the newest version ever
 * approved, still approved (the library's supersession rule). Any failure gives an empty list.
 */
export function approvedClausePicks(s: unknown): LibraryPick[] {
  const p = principalOf(s);
  if (!p || !capabilitiesOf(s).includes("view")) return [];
  try {
    bind(p); // ensures the tables exist
    const rows = all<{ id: string; title: string; version: number; placeholders: string }>(
      `SELECT c.id, c.title, v.version, v.placeholders
         FROM clause_library_clauses c
         JOIN clause_library_versions v ON v.workspace_id = c.workspace_id AND v.clause_id = c.id
        WHERE c.workspace_id = ? AND v.state = 'approved'
          AND v.version = (SELECT MAX(x.version) FROM clause_library_versions x
                            WHERE x.workspace_id = c.workspace_id AND x.clause_id = c.id AND x.state IN ('approved', 'retired'))
        ORDER BY c.title, c.id
        LIMIT 500`,
      p.workspaceId,
    );
    return rows.flatMap((r) => {
      try {
        const ph = JSON.parse(r.placeholders) as LibraryPick["placeholders"];
        return Array.isArray(ph) ? [{ id: r.id, title: r.title, version: Number(r.version), placeholders: ph }] : [];
      } catch {
        return [];
      }
    });
  } catch (e) {
    console.error("clause library picker failed", e);
    return [];
  }
}

/** Display names of the members of the session's workspace (history shows names, not ids). */
export function memberNames(s: unknown): Map<string, string> {
  const p = principalOf(s);
  if (!p) return new Map();
  const rows = all<{ id: string; name: string }>("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?", p.workspaceId);
  return new Map(rows.map((r) => [r.id, r.name]));
}
