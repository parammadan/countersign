import { DatabaseSync } from "node:sqlite";
import { assertAuthorizer, assertClauseShape, assertNewVersion, assertVersionUpdate, assertWorkspaceId, assertWriteAuthorized, requireCapability, snapshot } from "./governance";
import { ClauseError, type Clause, type ClauseAuthorizer, type ClauseStore, type ClauseVersion } from "./types";

type Row = Record<string, unknown>;

/**
 * The clause library's tables and triggers, idempotent (CREATE ... IF NOT EXISTS). In the app they live in
 * countersign.db and are created at first use on the app's own connection; lib/db.ts (owner-reserved) can take this
 * string verbatim as a numbered migration (docs/owner-patches/clause-library-migration.patch). Nothing here reads or
 * writes PRAGMA user_version.
 */
export const CLAUSES_TABLES_DDL = `
      CREATE TABLE IF NOT EXISTS clause_library_clauses (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS clause_library_versions (
        workspace_id TEXT NOT NULL,
        clause_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        placeholders TEXT NOT NULL,
        author TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('draft','in_review','approved','retired')),
        approved_by TEXT, approved_at TEXT,
        history TEXT NOT NULL,
        PRIMARY KEY (workspace_id, clause_id, version),
        FOREIGN KEY (workspace_id, clause_id) REFERENCES clause_library_clauses(workspace_id, id)
      );
    `;
export const CLAUSES_TRIGGERS_DDL = `
      CREATE TRIGGER IF NOT EXISTS clause_library_new BEFORE INSERT ON clause_library_versions
        WHEN NEW.state <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'clause version must start as a draft'); END;
      CREATE TRIGGER IF NOT EXISTS clause_library_frozen BEFORE UPDATE ON clause_library_versions
        WHEN OLD.state = 'retired'
          OR NEW.workspace_id <> OLD.workspace_id
          OR NEW.clause_id <> OLD.clause_id OR NEW.version <> OLD.version
          OR NEW.author <> OLD.author OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at
          OR (OLD.state <> 'draft' AND (NEW.body <> OLD.body OR NEW.placeholders <> OLD.placeholders))
          OR (OLD.state <> NEW.state AND (OLD.state || '>' || NEW.state) NOT IN ('draft>in_review','in_review>draft','in_review>approved','approved>retired'))
          OR (OLD.state <> NEW.state AND NEW.history = OLD.history)
          OR (OLD.state = NEW.state AND NEW.history <> OLD.history)
          OR (OLD.state = 'approved' AND (NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at))
          OR (NEW.state = 'approved' AND (NEW.approved_by IS NULL OR NEW.approved_by = NEW.author))
          OR (NEW.state IN ('draft','in_review') AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL))
        BEGIN SELECT RAISE(ABORT, 'clause version is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS clause_library_no_delete BEFORE DELETE ON clause_library_versions
        BEGIN SELECT RAISE(ABORT, 'clause versions are never deleted'); END;
      CREATE TRIGGER IF NOT EXISTS clause_library_clause_frozen BEFORE UPDATE ON clause_library_clauses
        BEGIN SELECT RAISE(ABORT, 'clause record is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS clause_library_clause_no_delete BEFORE DELETE ON clause_library_clauses
        BEGIN SELECT RAISE(ABORT, 'clauses are never deleted'); END;
    `;
export const CLAUSES_DDL = CLAUSES_TABLES_DDL + CLAUSES_TRIGGERS_DDL;

/**
 * node:sqlite store owned by this module. It opens its own database from a path (":memory:" is fine) or runs on a
 * connection the host already has open (the app's countersign.db), and it needs the host authorizer, without which
 * it refuses to open. On a host connection it changes no pragma: the host owns foreign keys, WAL and busy timeout.
 * Every row carries its workspace and every query is scoped by it. Triggers repeat the immutability rules at the
 * database level as a second line of defence; they cannot see roles, so a raw-SQL writer is trusted like a database
 * administrator.
 */
export class SqliteClauseStore implements ClauseStore {
  private db: DatabaseSync;
  private auth: ClauseAuthorizer;
  private owned: boolean;

  /** `busyTimeoutMs` (own database only): how long a writer waits for another connection's lock (default 5000). */
  constructor(target: string | DatabaseSync, opts: { authorizer: ClauseAuthorizer; busyTimeoutMs?: number }) {
    assertAuthorizer(opts?.authorizer);
    this.auth = opts.authorizer;
    if (typeof target === "string") {
      const wait = opts.busyTimeoutMs ?? 5000;
      if (!Number.isInteger(wait) || wait < 0) throw new ClauseError("bad_option", "busyTimeoutMs must be a non-negative integer");
      this.db = new DatabaseSync(target);
      this.owned = true;
      this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${wait};`);
    } else {
      if (!target || typeof target.prepare !== "function") throw new ClauseError("bad_option", "A database path or an open connection is required");
      this.db = target;
      this.owned = false;
    }
    this.db.exec(CLAUSES_TABLES_DDL);
    // An older single-tenant schema has no workspace column: refuse it rather than mix tenants.
    for (const t of ["clause_library_clauses", "clause_library_versions"]) {
      const cols = (this.db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => r.name);
      if (!cols.includes("workspace_id")) {
        if (this.owned) this.db.close();
        throw new ClauseError("schema_mismatch", `${t} has no workspace_id column; migrate the database before opening it`);
      }
    }
    this.db.exec(CLAUSES_TRIGGERS_DDL);
  }

  /** Closes the database if this store opened it; a host connection is left to its owner. */
  close(): void {
    if (this.owned) this.db.close();
  }

  private toVersion(r: Row): ClauseVersion {
    return {
      version: Number(r.version), body: r.body as string, placeholders: JSON.parse(r.placeholders as string),
      provenance: { author: r.author as string, source: JSON.parse(r.source as string), createdAt: r.created_at as string },
      state: r.state as ClauseVersion["state"], approvedBy: (r.approved_by as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null, history: JSON.parse(r.history as string),
    };
  }

  private toClause(r: Row): Clause {
    const versions = this.db
      .prepare("SELECT * FROM clause_library_versions WHERE workspace_id = ? AND clause_id = ? ORDER BY version")
      .all(r.workspace_id as string, r.id as string) as Row[];
    return {
      workspaceId: r.workspace_id as string, id: r.id as string, kind: r.kind as Clause["kind"], title: r.title as string,
      createdBy: r.created_by as string, createdAt: r.created_at as string, versions: versions.map((v) => this.toVersion(v)),
    };
  }

  private insertVersion(ws: string, clauseId: string, v: ClauseVersion): void {
    this.db.prepare(
      "INSERT INTO clause_library_versions (workspace_id, clause_id, version, body, placeholders, author, source, created_at, state, approved_by, approved_at, history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(ws, clauseId, v.version, v.body, JSON.stringify(v.placeholders), v.provenance.author, JSON.stringify(v.provenance.source),
      v.provenance.createdAt, v.state, v.approvedBy, v.approvedAt, JSON.stringify(v.history));
  }

  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn(); // inside the host's transaction, which already holds the write lock
    this.db.exec("BEGIN IMMEDIATE"); // write lock first, so the checks below cannot go stale
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  insertClause(workspaceId: string, input: Clause): void {
    assertAuthorizer(this.auth);
    assertWorkspaceId(workspaceId);
    const c = snapshot(input); // validate and write the same private copy
    assertClauseShape(c);
    this.tx(() => {
      if (c.workspaceId !== workspaceId) throw new ClauseError("bad_workspace", "Clause belongs to another workspace");
      if (this.db.prepare("SELECT 1 FROM clause_library_clauses WHERE workspace_id = ? AND id = ?").get(workspaceId, c.id)) {
        throw new ClauseError("exists", `Clause ${c.id} already exists`);
      }
      if (c.versions.length !== 1 || c.versions[0].version !== 1) throw new ClauseError("bad_version", "A new clause starts with exactly version 1");
      assertNewVersion(c.versions[0]);
      if (c.createdBy !== c.versions[0].provenance.author) throw new ClauseError("immutable", "A clause is created by the author of its first version");
      assertWriteAuthorized(this.auth, workspaceId, null, c.versions[0]);
      requireCapability(this.auth, workspaceId, c.createdBy, "edit", "Creating a clause needs edit permission in this workspace");
      this.db.prepare("INSERT INTO clause_library_clauses (workspace_id, id, kind, title, created_by, created_at) VALUES (?,?,?,?,?,?)")
        .run(workspaceId, c.id, c.kind, c.title, c.createdBy, c.createdAt);
      this.insertVersion(workspaceId, c.id, c.versions[0]);
    });
  }

  getClause(workspaceId: string, id: string): Clause | null {
    assertWorkspaceId(workspaceId);
    const r = this.db.prepare("SELECT * FROM clause_library_clauses WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as Row | undefined;
    return r ? this.toClause(r) : null;
  }

  listClauses(workspaceId: string): Clause[] {
    assertWorkspaceId(workspaceId);
    return (this.db.prepare("SELECT * FROM clause_library_clauses WHERE workspace_id = ? ORDER BY id").all(workspaceId) as Row[]).map((r) => this.toClause(r));
  }

  saveVersion(workspaceId: string, clauseId: string, input: ClauseVersion): void {
    assertAuthorizer(this.auth);
    assertWorkspaceId(workspaceId);
    const v = snapshot(input); // validate and write the same private copy
    this.tx(() => {
      const c = this.getClause(workspaceId, clauseId);
      if (!c) throw new ClauseError("not_found", `No clause ${clauseId}`);
      const prev = c.versions.find((x) => x.version === v.version);
      if (!prev) {
        if (v.version !== c.versions.length + 1) throw new ClauseError("bad_version", "Versions are numbered consecutively");
        assertNewVersion(v);
        assertWriteAuthorized(this.auth, workspaceId, null, v);
        this.insertVersion(workspaceId, clauseId, v);
        return;
      }
      assertVersionUpdate(prev, v);
      assertWriteAuthorized(this.auth, workspaceId, prev, v);
      // BEGIN IMMEDIATE holds the write lock, so `prev` read above cannot go stale before this UPDATE.
      this.db.prepare(
        "UPDATE clause_library_versions SET body=?, placeholders=?, state=?, approved_by=?, approved_at=?, history=? WHERE workspace_id=? AND clause_id=? AND version=?",
      ).run(v.body, JSON.stringify(v.placeholders), v.state, v.approvedBy, v.approvedAt, JSON.stringify(v.history), workspaceId, clauseId, v.version);
    });
  }
}
