import {
  assertAuthorizer, snapshotActor, assertTransition, checkSource, isSuperseded, requireCapability,
} from "./governance";
import { renderBody, validateBody } from "./render";
import { unsafeMarkers } from "./safety";
import {
  CLAUSE_KINDS, ClauseError, type Actor, type Clause, type ClauseAuthorizer, type ClauseKind, type ClauseSource,
  type ClauseStore, type ClauseVersion, type Params, type VersionState,
} from "./types";

const ID = /^[a-z][a-z0-9-]{2,63}$/;

export interface NewClause { id: string; kind: ClauseKind; title: string; body: string; source: ClauseSource }

/** Free-text metadata (title, notes) must be short plain text. */
function plainText(label: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new ClauseError("bad_text", `${label} must be text`);
  const t = value.trim();
  if (!t) throw new ClauseError(label === "Title" ? "bad_title" : "bad_text", `${label} is required`);
  if (t.length > max) throw new ClauseError("bad_text", `${label} is longer than ${max} characters`);
  const bad = unsafeMarkers(t);
  if (bad.length) throw new ClauseError("bad_text", `${label}: ${bad[0].message}`, bad);
  return t;
}

/**
 * The clause catalog and its approval workflow, for one host.
 *
 * What it enforces: every call names an `Actor` ({ workspaceId, id }) and is scoped to that workspace; what the
 * actor may do comes only from the host's `ClauseAuthorizer` (viewer / editor / approver), never from the caller;
 * an author (or any id the host maps to the same person) never approves their own version; the store re-checks
 * the named user's role on every write, on its own copy of the data. The actor is copied once (plain data
 * properties only) and only that copy is used. What it cannot enforce: that the actor really is the logged-in user.
 * The host must build the actor from its authenticated session, and must not let two accounts of one human
 * look like two people unless `personOf` says so.
 */
export class ClauseLibrary {
  constructor(private store: ClauseStore, private auth: ClauseAuthorizer, private now: () => string = () => new Date().toISOString()) {
    assertAuthorizer(auth);
    if (!store || typeof store.getClause !== "function") throw new ClauseError("no_store", "A clause store is required");
  }

  /**
   * Snapshots and validates the actor, then requires a capability BEFORE any lookup, so a non-member learns
   * nothing. Every method uses only the returned snapshot, never the caller's object again.
   */
  private allow(actor: Actor, cap: "view" | "edit", what: string): Actor {
    const a = snapshotActor(actor);
    requireCapability(this.auth, a.workspaceId, a.id, cap, `${what} needs the ${cap} permission in this workspace`);
    return a;
  }

  private requireClause(ws: string, id: string): Clause {
    const c = this.store.getClause(ws, id);
    if (!c || c.workspaceId !== ws) throw new ClauseError("not_found", `No clause ${id}`);
    return c;
  }

  private requireVersion(ws: string, id: string, n: number): { clause: Clause; v: ClauseVersion } {
    const clause = this.requireClause(ws, id);
    const v = clause.versions.find((x) => x.version === n);
    if (!v) throw new ClauseError("not_found", `No version ${n} of ${id}`);
    return { clause, v };
  }

  private newVersion(n: number, body: string, source: unknown, actor: Actor): ClauseVersion {
    const src = checkSource(source);
    const check = validateBody(body);
    if (!check.ok) throw new ClauseError("invalid_body", check.issues.map((i) => i.message).join("; "), check.issues);
    const at = this.now();
    return {
      version: n, body, placeholders: check.placeholders, provenance: { author: actor.id, source: src, createdAt: at },
      state: "draft", approvedBy: null, approvedAt: null, history: [{ from: null, to: "draft", by: actor.id, at }],
    };
  }

  createClause(input: NewClause, actor: Actor): Clause {
    const a = this.allow(actor, "edit", "Authoring");
    const ws = a.workspaceId;
    if (!input || typeof input !== "object") throw new ClauseError("bad_record", "A new clause is required");
    const { id, kind, title: rawTitle, body, source } = input; // each field read exactly once
    if (typeof id !== "string" || !ID.test(id)) throw new ClauseError("bad_id", "Clause id must be lowercase letters, digits and dashes");
    if (typeof kind !== "string" || !CLAUSE_KINDS.includes(kind)) throw new ClauseError("bad_kind", `Unknown kind ${String(kind)}`);
    const title = plainText("Title", rawTitle, 200);
    const v = this.newVersion(1, body, source, a);
    const clause: Clause = { workspaceId: ws, id, kind, title, createdBy: a.id, createdAt: v.provenance.createdAt, versions: [v] };
    this.store.insertClause(ws, clause);
    return clause;
  }

  /** A change to approved text is a new version, never an edit. */
  addVersion(id: string, body: string, source: ClauseSource, actor: Actor): ClauseVersion {
    const a = this.allow(actor, "edit", "Authoring");
    const ws = a.workspaceId;
    const c = this.requireClause(ws, id);
    if (c.versions.some((v) => v.state === "draft" || v.state === "in_review")) {
      throw new ClauseError("open_version", "Finish or send back the open version first");
    }
    const v = this.newVersion(c.versions.length + 1, body, source, a);
    this.store.saveVersion(ws, id, v);
    return v;
  }

  /** Edits a draft only, and only by its author while they hold edit permission. */
  editDraft(id: string, n: number, body: string, actor: Actor): ClauseVersion {
    const a = this.allow(actor, "edit", "Editing");
    const ws = a.workspaceId;
    const { v } = this.requireVersion(ws, id, n);
    if (v.state !== "draft") throw new ClauseError("immutable", `A ${v.state} version cannot be edited`);
    if (v.provenance.author !== a.id) throw new ClauseError("forbidden", "Only the author can edit a draft");
    const check = validateBody(body);
    if (!check.ok) throw new ClauseError("invalid_body", check.issues.map((i) => i.message).join("; "), check.issues);
    const next = { ...v, body, placeholders: check.placeholders };
    this.store.saveVersion(ws, id, next);
    return next;
  }

  transition(id: string, n: number, to: VersionState, actor: Actor, note?: string): ClauseVersion {
    const a = this.allow(actor, "view", "Changing a version");
    const ws = a.workspaceId;
    const { v } = this.requireVersion(ws, id, n);
    assertTransition(this.auth, v, to, a);
    if (note !== undefined) note = plainText("Note", note, 500);
    if (to === "in_review") {
      const check = validateBody(v.body);
      if (!check.ok) throw new ClauseError("invalid_body", "Body no longer validates", check.issues);
    }
    const at = this.now();
    const next: ClauseVersion = {
      ...v, state: to, history: [...v.history, { from: v.state, to, by: a.id, at, ...(note ? { note } : {}) }],
      ...(to === "approved" ? { approvedBy: a.id, approvedAt: at } : {}),
    };
    this.store.saveVersion(ws, id, next);
    return next;
  }

  submit = (id: string, n: number, actor: Actor) => this.transition(id, n, "in_review", actor);
  approve = (id: string, n: number, actor: Actor) => this.transition(id, n, "approved", actor);
  sendBack = (id: string, n: number, actor: Actor, note?: string) => this.transition(id, n, "draft", actor, note);
  retire = (id: string, n: number, actor: Actor, note?: string) => this.transition(id, n, "retired", actor, note);

  get(id: string, actor: Actor): Clause | null {
    const a = this.allow(actor, "view", "Reading clauses");
    const ws = a.workspaceId;
    const c = this.store.getClause(ws, id);
    return c && c.workspaceId === ws ? c : null;
  }
  list(actor: Actor): Clause[] {
    const a = this.allow(actor, "view", "Reading clauses");
    const ws = a.workspaceId;
    return this.store.listClauses(ws).filter((c) => c.workspaceId === ws);
  }
  /** The usable version: the newest one ever approved, if it is still approved; null once it is retired. */
  latestApproved(id: string, actor: Actor): ClauseVersion | null {
    const c = this.get(id, actor);
    if (!c) return null;
    const v = [...c.versions].reverse().find((x) => x.state === "approved" || x.state === "retired");
    return v && v.state === "approved" ? v : null;
  }

  /**
   * The only way to pull clause text into an agreement draft: approved versions, rendered with parameters.
   * Supersession rule: only the newest version ever approved is usable. Approving version N makes every
   * earlier version unusable (`superseded`) without changing it, and retiring N does NOT bring them back:
   * to reuse older wording, add it again as a new version and have it approved. History is untouched.
   */
  useInDraft(id: string, n: number, params: Params, actor: Actor): string {
    const a = this.allow(actor, "view", "Using a clause");
    const ws = a.workspaceId;
    const { clause, v } = this.requireVersion(ws, id, n);
    if (v.state !== "approved") throw new ClauseError("not_approved", `Version ${n} of ${id} is ${v.state}; only approved versions can be used`);
    if (isSuperseded(clause.versions, n)) {
      throw new ClauseError("superseded", `Version ${n} of ${id} is superseded by a later approved version`);
    }
    return renderBody(v.body, v.placeholders, params);
  }
}
