// Clause library types. The library is a catalog with an approval workflow; it makes no claim about
// the legal effect of any clause text.

export const CLAUSE_KINDS = [
  "confidentiality", "fees", "payment", "scope", "term", "termination", "liability", "general", "other",
] as const;
export type ClauseKind = (typeof CLAUSE_KINDS)[number];

// `text` is one line. `multiline` must be declared in the body (`{{notes:multiline}}`) and is the only type
// whose value may contain line feeds; no value of any type may contain other line or paragraph separators.
export const PLACEHOLDER_TYPES = ["text", "multiline", "int", "money", "date"] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

export const STATES = ["draft", "in_review", "approved", "retired"] as const;
export type VersionState = (typeof STATES)[number];

/**
 * What a user may do in the clause library of one workspace. The HOST decides it (see `ClauseAuthorizer`);
 * nothing the caller sends can grant it. Roles are separate grants, not a ladder:
 * - viewer: read clauses and use approved text in a draft.
 * - editor: read, write and submit drafts. Editing never implies approval.
 * - approver: read, approve, send back and retire versions. Approving never implies authoring.
 */
export const CLAUSE_ROLES = ["viewer", "editor", "approver"] as const;
export type ClauseRole = (typeof CLAUSE_ROLES)[number];
export type Capability = "view" | "edit" | "approve";

/** Workspace member roles of the host app (`lib/auth.ts` Session.role). */
export type MemberRole = "owner" | "admin" | "staff";

/**
 * The principal of one request, built by the host from its authenticated session (`Session.workspaceId`,
 * `Session.userId`), never from request input. It carries no roles: those come from the authorizer.
 */
export interface Actor { workspaceId: string; id: string }

/**
 * Supplied by the host. The library and every store refuse to work without one (fail closed).
 * - `rolesOf`: the user's clause roles in that workspace, from the host's own membership data (see
 *   `clauseRolesForMember`); null or [] when the user is not a member. Anything that is not an array of known
 *   roles grants nothing.
 * - `personOf` (optional): the human behind a user id. Two ids that map to the same person are treated as one
 *   for the self-approval rule; an id the host cannot map (null) is treated as possibly the author. Without
 *   it, each user id is its own person.
 */
export interface ClauseAuthorizer {
  rolesOf(workspaceId: string, userId: string): readonly ClauseRole[] | null;
  personOf?(workspaceId: string, userId: string): string | null;
}

/**
 * Where a version's text came from: a fixed kind plus an optional opaque reference key (e.g. a template or
 * ticket number). It is never free text, so it cannot claim approval or authority; approval is only ever
 * the version's own `approvedBy` record.
 */
export const SOURCE_KINDS = ["firm_template", "precedent", "negotiated", "new_drafting", "imported"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export interface ClauseSource { kind: SourceKind; ref?: string }

export interface Provenance { author: string; source: ClauseSource; createdAt: string }

export interface Transition { from: VersionState | null; to: VersionState; by: string; at: string; note?: string }

export interface Placeholder { path: string; type: PlaceholderType }

export interface ClauseVersion {
  version: number;
  body: string;
  placeholders: Placeholder[];
  provenance: Provenance;
  state: VersionState;
  approvedBy: string | null;
  approvedAt: string | null;
  history: Transition[];
}

export interface Clause {
  workspaceId: string;
  id: string;
  kind: ClauseKind;
  title: string;
  createdBy: string;
  createdAt: string;
  versions: ClauseVersion[];
}

export type ParamValue = string | number;
export type Params = Record<string, ParamValue>;

export interface Issue { code: string; message: string; path?: string }

export class ClauseError extends Error {
  constructor(public code: string, message: string, public issues: Issue[] = []) {
    super(message);
    this.name = "ClauseError";
  }
}

/**
 * Every call is scoped to one workspace: nothing reads or writes another workspace's clauses. Stores take a private
 * deep copy of what they are given, then check on that copy the record shape, the immutability rules AND, through
 * the host's authorizer, that whoever the write names (author, submitter, approver) holds the role for it in that
 * workspace now. A store cannot know who is calling it: a direct caller can name any entitled user, so only trusted
 * server code may hold a store, and requests must go through `ClauseLibrary` with a session-built actor.
 */
export interface ClauseStore {
  /** Inserts a new clause with its first version. Throws ClauseError("exists") on a duplicate id in the workspace. */
  insertClause(workspaceId: string, clause: Clause): void;
  /** Returns a deep copy, or null (also for a clause that exists only in another workspace). */
  getClause(workspaceId: string, id: string): Clause | null;
  listClauses(workspaceId: string): Clause[];
  /** Appends a version (number must be last + 1) or updates an existing one under the immutability rules. */
  saveVersion(workspaceId: string, clauseId: string, version: ClauseVersion): void;
}
