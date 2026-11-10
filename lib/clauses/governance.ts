import { parsePlaceholders } from "./placeholders";
import { unsafeMarkers } from "./safety";
import {
  CLAUSE_KINDS, ClauseError, SOURCE_KINDS, STATES, type Actor, type Clause, type Capability, type ClauseAuthorizer, type ClauseRole, type ClauseSource,
  type ClauseVersion, type MemberRole, type VersionState,
} from "./types";

/** Allowed moves and the capability each needs. */
export const MOVES: Readonly<Record<string, Capability>> = Object.freeze({
  "draft>in_review": "edit", // and only by the draft's author
  "in_review>draft": "approve", // send back
  "in_review>approved": "approve", // and never by the author's person
  "approved>retired": "approve",
});

/** What each clause role may do. Roles are separate grants: editing never implies approval, nor the reverse. */
export const ROLE_CAPABILITIES: Readonly<Record<ClauseRole, readonly Capability[]>> = Object.freeze({
  viewer: Object.freeze(["view"] as Capability[]),
  editor: Object.freeze(["view", "edit"] as Capability[]),
  approver: Object.freeze(["view", "approve"] as Capability[]),
});

/**
 * The production mapping from the host's member roles: viewer and editor for owner, admin and staff;
 * approver for owner and admin only. Anything else, including an unknown role, maps to [] (no access).
 */
export function clauseRolesForMember(role: MemberRole | string | null | undefined): ClauseRole[] {
  if (role === "owner" || role === "admin") return ["viewer", "editor", "approver"];
  if (role === "staff") return ["viewer", "editor"];
  return [];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

/** Fails closed: no authorizer, or one without a `rolesOf` function, means nothing is allowed. */
export function assertAuthorizer(auth: unknown): asserts auth is ClauseAuthorizer {
  const a = auth as ClauseAuthorizer | null | undefined;
  if (!a || typeof a !== "object" || typeof a.rolesOf !== "function" || (a.personOf !== undefined && typeof a.personOf !== "function")) {
    throw new ClauseError("no_authorizer", "The clause library needs a host-supplied authorizer (rolesOf) and refuses to run without one");
  }
}

export function assertWorkspaceId(ws: unknown): asserts ws is string {
  if (typeof ws !== "string" || !ID.test(ws)) throw new ClauseError("bad_workspace", "A workspace id is required");
}

/**
 * An actor is exactly a plain { workspaceId, id } of string data properties; a `roles` field (or any other),
 * getters, proxies-with-prototypes and class instances are refused. Returns a fresh frozen copy, which is the
 * only thing the library uses afterwards, so the caller's object cannot change between check and use.
 */
export function snapshotActor(actor: unknown): Actor {
  const bad = (m: string): never => { throw new ClauseError("bad_actor", m); };
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) bad("An actor is required");
  const proto = Object.getPrototypeOf(actor);
  if (proto !== Object.prototype && proto !== null) bad("An actor must be a plain object");
  const keys = Reflect.ownKeys(actor as object);
  if (keys.length !== 2 || !keys.includes("workspaceId") || !keys.includes("id")) {
    bad("An actor carries only workspaceId and id; roles come from the host authorizer, never from the caller");
  }
  const read = (k: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(actor, k);
    return d && "value" in d ? d.value : bad("Actor fields must be plain values, not accessors");
  };
  const workspaceId = read("workspaceId");
  const id = read("id");
  assertWorkspaceId(workspaceId);
  if (typeof id !== "string" || !ID.test(id)) bad("An actor needs a user id");
  return Object.freeze({ workspaceId, id: id as string });
}

/**
 * Stores validate and save a private deep copy of what they are given (structuredClone reads every field once
 * and drops prototypes, getters and toJSON), so a live object cannot answer one value to the checks and
 * another to the write. Functions, symbols and other non-data values are refused.
 */
export function snapshot<T>(x: T): T {
  try {
    return structuredClone(x);
  } catch {
    throw new ClauseError("bad_record", "Clause records must be plain data");
  }
}

const TIME = /^[\w:.+-]{1,40}$/;
const CLAUSE_ID = /^[a-z][a-z0-9-]{2,63}$/;

/** One history entry: { from, to, by, at, note? } with known states, a user id, a timestamp and a plain-text note. */
function assertEntry(e: unknown): void {
  const fail = (m: string): never => { throw new ClauseError("immutable", m); };
  if (!e || typeof e !== "object" || Array.isArray(e)) fail("A history entry must be an object");
  const h = e as Record<string, unknown>;
  if (Object.keys(h).some((k) => !["from", "to", "by", "at", "note"].includes(k))) fail("A history entry has only from, to, by, at and note");
  if (h.from !== null && !(STATES as readonly unknown[]).includes(h.from)) fail("Unknown history state");
  if (!(STATES as readonly unknown[]).includes(h.to)) fail("Unknown history state");
  if (typeof h.by !== "string" || !ID.test(h.by)) fail("A history entry needs a user id");
  if (typeof h.at !== "string" || !TIME.test(h.at)) fail("A history entry needs a timestamp");
  if (h.note !== undefined) {
    if (typeof h.note !== "string" || !h.note.trim() || h.note !== h.note.trim() || h.note.length > 500 || unsafeMarkers(h.note).length) {
      throw new ClauseError("bad_text", "A history note must be short plain text");
    }
  }
}

/** The shape every stored version must have, whoever wrote it. */
const VERSION_KEYS = ["version", "body", "placeholders", "provenance", "state", "approvedBy", "approvedAt", "history"];
const CLAUSE_KEYS = ["workspaceId", "id", "kind", "title", "createdBy", "createdAt", "versions"];
const sig = (ps: Array<{ path: string; type: string }>) => JSON.stringify(ps.map((p) => `${p.path}:${p.type}`).sort());

export function assertVersionShape(v: ClauseVersion): void {
  const fail = (m: string): never => { throw new ClauseError("immutable", m); };
  if (!v || typeof v !== "object") fail("A version must be an object");
  if (Object.keys(v).length !== VERSION_KEYS.length || Object.keys(v).some((k) => !VERSION_KEYS.includes(k))) fail(`A version has exactly ${VERSION_KEYS.join(", ")}`);
  if (!Number.isSafeInteger(v.version) || v.version < 1) fail("Bad version number");
  if (typeof v.body !== "string" || !Array.isArray(v.placeholders)) fail("A version needs a body and placeholders");
  // Placeholders are exactly what the body declares: { path, type } entries, nothing else.
  if (v.placeholders.some((p) => !p || typeof p !== "object" || Object.keys(p).length !== 2 || typeof p.path !== "string" || typeof p.type !== "string")) {
    fail("A placeholder is exactly { path, type }");
  }
  const parsed = parsePlaceholders(v.body);
  if (parsed.issues.length || sig(parsed.placeholders) !== sig(v.placeholders)) fail("Placeholders must match the body");
  if (!(STATES as readonly unknown[]).includes(v.state)) fail("Unknown state");
  const p = v.provenance;
  if (!p || typeof p !== "object" || Object.keys(p).some((k) => !["author", "source", "createdAt"].includes(k))) fail("Provenance has only author, source and createdAt");
  if (typeof p.author !== "string" || !ID.test(p.author) || typeof p.createdAt !== "string" || !TIME.test(p.createdAt)) fail("Provenance needs an author id and a timestamp");
  for (const [x, ok] of [[v.approvedBy, ID], [v.approvedAt, TIME]] as const) if (x !== null && (typeof x !== "string" || !ok.test(x))) fail("Bad approval record");
  if (!Array.isArray(v.history) || !v.history.length) fail("A version needs a history");
  v.history.forEach(assertEntry);
}

/** The clause record a store inserts: a known id pattern, kind and plain-text title. */
export function assertClauseShape(c: Clause): void {
  if (!c || typeof c !== "object") throw new ClauseError("bad_record", "A clause must be an object");
  if (Object.keys(c).length !== CLAUSE_KEYS.length || Object.keys(c).some((k) => !CLAUSE_KEYS.includes(k))) {
    throw new ClauseError("bad_record", `A clause has exactly ${CLAUSE_KEYS.join(", ")}`);
  }
  if (typeof c.id !== "string" || !CLAUSE_ID.test(c.id)) throw new ClauseError("bad_id", "Clause id must be lowercase letters, digits and dashes");
  if (!(CLAUSE_KINDS as readonly unknown[]).includes(c.kind)) throw new ClauseError("bad_kind", "Unknown kind");
  if (typeof c.title !== "string" || !c.title.trim() || c.title.length > 200 || unsafeMarkers(c.title).length) throw new ClauseError("bad_text", "Title must be short plain text");
  if (typeof c.createdAt !== "string" || !TIME.test(c.createdAt) || !Array.isArray(c.versions)) throw new ClauseError("bad_record", "Bad clause record");
}

/** The capabilities the host grants this user in this workspace (none for a non-member or an unknown role). */
export function capabilitiesOf(auth: ClauseAuthorizer, ws: string, userId: string): readonly Capability[] {
  assertAuthorizer(auth);
  if (typeof userId !== "string" || !ID.test(userId)) return [];
  const roles: unknown = auth.rolesOf(ws, userId);
  if (!Array.isArray(roles)) return [];
  const caps = new Set<Capability>();
  for (const r of roles) {
    if (typeof r === "string" && Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, r)) {
      for (const c of ROLE_CAPABILITIES[r as ClauseRole]) caps.add(c);
    }
  }
  return [...caps];
}

export function holds(auth: ClauseAuthorizer, ws: string, userId: string, cap: Capability): boolean {
  return capabilitiesOf(auth, ws, userId).includes(cap);
}

export function requireCapability(auth: ClauseAuthorizer, ws: string, userId: string, cap: Capability, message: string): void {
  if (!holds(auth, ws, userId, cap)) throw new ClauseError("forbidden", message);
}

/** True when the host says (or cannot rule out) that two user ids are the same human. */
export function samePerson(auth: ClauseAuthorizer, ws: string, a: string, b: string): boolean {
  assertAuthorizer(auth);
  if (a === b) return true;
  if (!auth.personOf) return false;
  const pa = auth.personOf(ws, a);
  const pb = auth.personOf(ws, b);
  if (typeof pa !== "string" || !pa || typeof pb !== "string" || !pb) return true; // unknown person: assume the author
  return pa === pb;
}

const SOURCE_REF = /^[A-Z]{2,6}-[0-9]{1,8}$/;

/** A source is { kind } or { kind, ref } with a fixed kind and an opaque key like "LEG-1234". Never free text. */
export function checkSource(source: unknown): ClauseSource {
  const fail = (m: string): never => { throw new ClauseError("bad_source", m); };
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return fail(`Source must be { kind, ref? } with kind one of ${SOURCE_KINDS.join(", ")}; free text is not accepted`);
  }
  const s = source as Record<string, unknown>;
  if (Object.keys(s).some((k) => k !== "kind" && k !== "ref")) fail("Source has only kind and ref");
  if (typeof s.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(s.kind)) fail(`Unknown source kind; use one of ${SOURCE_KINDS.join(", ")}`);
  if (s.ref !== undefined && (typeof s.ref !== "string" || !SOURCE_REF.test(s.ref))) fail("Source ref is an opaque key such as LEG-1234");
  return s.ref === undefined ? { kind: s.kind as ClauseSource["kind"] } : { kind: s.kind as ClauseSource["kind"], ref: s.ref as string };
}

/** Library-level check of one requested move by the actor. */
export function assertTransition(auth: ClauseAuthorizer, v: ClauseVersion, to: VersionState, actor: Actor): void {
  if (typeof to !== "string" || !(STATES as readonly string[]).includes(to)) throw new ClauseError("bad_transition", "Unknown target state");
  const cap = MOVES[`${v.state}>${to}`];
  if (!cap) throw new ClauseError("bad_transition", `Cannot move a version from ${v.state} to ${to}`);
  requireCapability(auth, actor.workspaceId, actor.id, cap, `Moving ${v.state} to ${to} needs the ${cap} permission`);
  if (v.state === "draft" && actor.id !== v.provenance.author) {
    throw new ClauseError("forbidden", "Only the author of a draft can submit it");
  }
  if (to === "approved" && samePerson(auth, actor.workspaceId, actor.id, v.provenance.author)) {
    throw new ClauseError("self_approval", "The author of a version cannot approve it");
  }
}

/**
 * Store-level check, run on every write after `assertVersionUpdate`/`assertNewVersion`: whoever the write
 * names must hold the role for it in this workspace NOW, per the host authorizer. A store cannot tell who is
 * calling it, only that the named user is entitled; binding the name to the caller is the host's job.
 */
export function assertWriteAuthorized(auth: ClauseAuthorizer, ws: string, prev: ClauseVersion | null, next: ClauseVersion): void {
  if (!prev) {
    requireCapability(auth, ws, next.provenance.author, "edit", "The author of a new version needs edit permission in this workspace");
    return;
  }
  if (next.state === prev.state) {
    // Only a draft can change without a state change (assertVersionUpdate), and only its author edits it.
    requireCapability(auth, ws, prev.provenance.author, "edit", "The author of this draft no longer has edit permission");
    return;
  }
  const last = next.history[next.history.length - 1];
  const cap = MOVES[`${prev.state}>${next.state}`];
  requireCapability(auth, ws, last.by, cap, `Moving ${prev.state} to ${next.state} needs the ${cap} permission`);
  if (prev.state === "draft" && last.by !== prev.provenance.author) throw new ClauseError("forbidden", "Only the author of a draft can submit it");
  if (next.state === "approved" && samePerson(auth, ws, last.by, prev.provenance.author)) {
    throw new ClauseError("self_approval", "The author of a version cannot approve it");
  }
}

/**
 * Supersession: a version is usable only while it is approved AND no later version has ever been approved
 * (a retired version was always approved first). Retiring the newest version therefore never brings older
 * text back; to reuse old wording, add it again as a new version and have it approved.
 */
export function isSuperseded(versions: ClauseVersion[], n: number): boolean {
  return versions.some((x) => x.version > n && (x.state === "approved" || x.state === "retired"));
}

/**
 * Shared by every store: what may change in a persisted version.
 * - draft: anything (body, placeholders, state).
 * - in_review: state only (to draft or approved).
 * - approved: state to retired only; approvedBy/approvedAt frozen.
 * - retired: nothing.
 * History is append-only in every state.
 */
export function assertVersionUpdate(prev: ClauseVersion, next: ClauseVersion): void {
  const fail = (m: string) => { throw new ClauseError("immutable", m); };
  assertVersionShape(next);
  if (next.version !== prev.version) fail("Version number cannot change");
  if (JSON.stringify(next.provenance) !== JSON.stringify(prev.provenance)) fail("Provenance cannot change");
  if (!Array.isArray(next.history) || next.history.length < prev.history.length || JSON.stringify(next.history.slice(0, prev.history.length)) !== JSON.stringify(prev.history)) {
    fail("History is append-only");
  }
  if (prev.state === "retired") fail("A retired version cannot change");
  if (next.state !== prev.state) {
    // Every state change must be a legal move, recorded as exactly one new history entry.
    if (!MOVES[`${prev.state}>${next.state}`]) fail(`Cannot move a version from ${prev.state} to ${next.state}`);
    const last = next.history[next.history.length - 1];
    if (next.history.length !== prev.history.length + 1 || last.from !== prev.state || last.to !== next.state) {
      fail("A state change must append its own history entry");
    }
    if (next.state === "approved") {
      if (next.approvedBy !== last.by || next.approvedAt !== last.at) fail("Approval record must match the history entry");
      if (next.approvedBy === prev.provenance.author) throw new ClauseError("self_approval", "The author of a version cannot approve it");
    } else if (next.state !== "retired" && (next.approvedBy !== null || next.approvedAt !== null)) {
      fail("Only approved or retired versions carry an approval record");
    }
  } else {
    if (next.history.length !== prev.history.length) fail("History changes only with a state change");
    if (next.approvedBy !== prev.approvedBy || next.approvedAt !== prev.approvedAt) fail("Approval record cannot change without a state change");
  }
  if (prev.state === "draft") return;
  if (next.body !== prev.body || JSON.stringify(next.placeholders) !== JSON.stringify(prev.placeholders)) {
    fail(`A ${prev.state} version's body cannot change`);
  }
  if (prev.state === "approved") {
    if (next.state !== "approved" && next.state !== "retired") fail("An approved version can only be retired");
    if (next.approvedBy !== prev.approvedBy || next.approvedAt !== prev.approvedAt) fail("Approval record cannot change");
  }
}

/** Every inserted version starts as a plain draft, never pre-approved, with a structured source. */
export function assertNewVersion(v: ClauseVersion): void {
  const fail = (m: string) => { throw new ClauseError("immutable", m); };
  assertVersionShape(v);
  const h = v.history;
  if (v.state !== "draft" || v.approvedBy !== null || v.approvedAt !== null) fail("A new version must be a draft");
  if (!Array.isArray(h) || h.length !== 1 || h[0].from !== null || h[0].to !== "draft" || h[0].by !== v.provenance.author) {
    fail("A new version starts with a single draft history entry by its author");
  }
  const s = checkSource(v.provenance.source);
  if (JSON.stringify(s) !== JSON.stringify(v.provenance.source)) throw new ClauseError("bad_source", "Source has only kind and ref");
}
