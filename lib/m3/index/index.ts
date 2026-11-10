/**
 * Tenant-isolated document index on node:sqlite. Two entry points: `openIndex(path)` owns its own file (":memory:" or a
 * path) and refuses any file that holds anything but the index; `openIndexOnDatabase(db)` runs on a connection the host
 * owns, never touches its pragmas or `user_version`, and by default only checks the host's migration created the tables.
 * Every statement filters by workspace_id; the prepared statements below are the only SQL, and nothing
 * exported takes a raw query or an unscoped id.
 *
 * Versions are not ordered by this module: the caller says which version is active (put active / supersede).
 * A put of an already-superseded version never reactivates it. Callers should still serialise puts per document.
 *
 * Credit: the shape of the add/replace/remove layer (removal drops everything for a document) follows claude/Q12-retrieval (retrieval/index.ts). Its ranking is NOT reused; this module does no ranking.
 */
// a static import, as in lib/db.ts (the sandbox's createRequire workaround fails this app's Next build)
import { DatabaseSync, type StatementSync } from "node:sqlite";
type DatabaseSyncT = DatabaseSync;
import { looksLikeInjection } from "./injection";
import { EXPECTED_OBJECTS, INDEX_OBJECTS, M3_INDEX_DDL, normalizeSql, SCHEMA_VERSION } from "./schema";
import type {
  IndexedDocument,
  IndexedPassage,
  IndexStats,
  PassageFlag,
  PassagesOptions,
  SqliteIndex,
} from "./types";


export { M3_INDEX_DDL };

export const LIMITS = {
  idChars: 200,
  passagesPerVersion: 5_000,
  passageChars: 20_000,
  versionChars: 5_000_000,
  versionsPerDocument: 200,
  queryLimit: 10_000,
} as const;

export class IndexError extends Error {
  constructor(
    /**
     * schema: the file's index schema is newer than this module. schema_missing: the host database lacks (part of) the
     * index tables. not_index_database: `openIndex(path)` was pointed at a file holding other tables (an app database).
     */
    readonly code: "invalid" | "limit" | "not_found" | "schema" | "schema_missing" | "not_index_database" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "IndexError";
  }
}

function id(label: string, v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > LIMITS.idChars || /[\u0000-\u001f]/.test(v))
    throw new IndexError("invalid", `${label} must be a non-empty string of at most ${LIMITS.idChars} characters`);
  return v;
}

function validate(doc: IndexedDocument): void {
  if (doc === null || typeof doc !== "object") throw new IndexError("invalid", "document must be an object");
  id("workspaceId", doc.workspaceId);
  id("documentId", doc.documentId);
  id("versionId", doc.versionId);
  if ((doc.status as string) === "deleted") throw new IndexError("invalid", "use remove() to delete a document");
  if (doc.status !== "active" && doc.status !== "superseded") throw new IndexError("invalid", "bad status");
  if (typeof doc.binding !== "boolean") throw new IndexError("invalid", "binding must be a boolean");
  if (!Array.isArray(doc.passages)) throw new IndexError("invalid", "passages must be an array");
  if (doc.passages.length > LIMITS.passagesPerVersion)
    throw new IndexError("limit", `more than ${LIMITS.passagesPerVersion} passages`);
  const seen = new Set<string>();
  let total = 0;
  for (const p of doc.passages) {
    id("passage id", p?.id);
    if (seen.has(p.id)) throw new IndexError("invalid", `duplicate passage id ${p.id}`);
    seen.add(p.id);
    if (!Number.isInteger(p.page) || p.page < 1) throw new IndexError("invalid", "page must be an integer >= 1");
    if (typeof p.text !== "string") throw new IndexError("invalid", "passage text must be a string");
    if (p.text.includes("\u0000")) throw new IndexError("invalid", "passage text must not contain NUL");
    if (typeof p.binding !== "boolean") throw new IndexError("invalid", "passage binding must be a boolean");
    if (p.text.length > LIMITS.passageChars)
      throw new IndexError("limit", `passage ${p.id} exceeds ${LIMITS.passageChars} characters`);
    total += p.text.length;
  }
  if (total > LIMITS.versionChars) throw new IndexError("limit", `version exceeds ${LIMITS.versionChars} characters`);
}

type Db = DatabaseSyncT;

/**
 * Run `fn` atomically. Outside a transaction: BEGIN IMMEDIATE ... COMMIT. Inside one the caller (a host) already
 * opened: a savepoint, so the host's transaction is neither committed nor broken by the index.
 */
function atomically<T>(db: Db, fn: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT m3_index" : "BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec(nested ? "RELEASE m3_index" : "COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec(nested ? "ROLLBACK TO m3_index; RELEASE m3_index" : "ROLLBACK");
    } catch {
      /* keep the original error */
    }
    throw e;
  }
}

/** Read-only: throws unless the file holds nothing but the index (an empty file is fine). */
function refuseForeignFile(db: Db): void {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all() as { type: string; name: string }[];
  const foreign = objects.filter((o) => !INDEX_OBJECTS.includes(o.name));
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 5).map((o) => `${o.type} ${o.name}`).join(", ");
    throw new IndexError(
      "not_index_database",
      `refusing to open a database that holds other schema objects (${shown}${foreign.length > 5 ? ", ..." : ""}); ` +
        "to host the index in an app database, add M3_INDEX_DDL as a migration and use openIndexOnDatabase(db)",
    );
  }
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION)
    throw new IndexError("schema", `database schema ${current} is newer than this module (${SCHEMA_VERSION})`);
  if (current !== 0 && current !== SCHEMA_VERSION)
    throw new IndexError("not_index_database", `refusing to open a database with user_version ${current}`);
}

/**
 * Read-only: how the database differs from M3_INDEX_DDL (empty = usable). Each object must exist in `main` with the
 * exact definition (normalized: see normalizeSql), so a changed type, collation, STRICT, WITHOUT ROWID or index
 * predicate is refused rather than silently weakening workspace isolation or the one-active-version rule. A TEMP
 * object of the same name would shadow it for the index's unqualified statements, so that is refused too.
 */
function schemaProblems(db: Db): string[] {
  const out: string[] = [];
  for (const [name, want] of EXPECTED_OBJECTS) {
    const got = db.prepare("SELECT type, sql FROM main.sqlite_schema WHERE name = ?").get(name) as
      | { type: string; sql: string | null }
      | undefined;
    if (!got) out.push(`${want.type} ${name} is missing`);
    else if (got.type !== want.type || normalizeSql(got.sql ?? "") !== want.sql) out.push(`${want.type} ${name} differs from M3_INDEX_DDL`);
  }
  const shadows = db.prepare("SELECT name FROM temp.sqlite_schema WHERE name LIKE 'm3\\_%' ESCAPE '\\'").all() as { name: string }[];
  for (const s of shadows) out.push(`temp object ${s.name} shadows the index`);
  return out;
}

/** Open (or create) a file that holds only the index. Refuses an app database: see `refuseForeignFile`. */
export function openIndex(path: string): SqliteIndex {
  if (typeof path !== "string") throw new IndexError("invalid", "path must be a string");
  const db: Db = new DatabaseSync(path);
  try {
    // Connection settings only (not stored in the file).
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    refuseForeignFile(db); // before any write lock is taken on a foreign file
    atomically(db, () => {
      refuseForeignFile(db); // again under the write lock, so nothing can appear in between
      db.exec(M3_INDEX_DDL);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } catch (e) {
    db.close();
    throw e;
  }
  return build(db, () => db.close());
}

export type HostDatabaseOptions = {
  /**
   * true: run M3_INDEX_DDL (CREATE ... IF NOT EXISTS) on the host database first, for tests and local tools.
   * Default false: the host's own migration creates the tables and the index only checks they are there.
   */
  create?: boolean;
};

/**
 * Run the index on a database the host owns (e.g. lib/db.ts's connection), in the tables M3_INDEX_DDL defines.
 * Never reads or writes `PRAGMA user_version` and sets no pragma (foreign_keys, secure_delete, journal_mode,
 * busy_timeout stay the host's choice); the index does not rely on foreign-key cascades. Writes join the host's
 * transaction through a savepoint if one is open. If SQLite itself aborts the host's whole transaction (disk full,
 * I/O error), the index's error is rethrown and the host sees the loss at its own COMMIT. `close()` stops the index
 * and leaves the host's connection open.
 */
export function openIndexOnDatabase(db: Db, opts?: HostDatabaseOptions): SqliteIndex {
  if (db === null || typeof db !== "object" || typeof db.prepare !== "function" || typeof db.exec !== "function" || db.isOpen === false)
    throw new IndexError("invalid", "db must be an open node:sqlite DatabaseSync");
  if (opts?.create === true) atomically(db, () => db.exec(M3_INDEX_DDL));
  const problems = schemaProblems(db);
  if (problems.length > 0)
    throw new IndexError(
      "schema_missing",
      `the host database lacks the index schema (${problems.join("; ")}): apply M3_INDEX_DDL unchanged in a migration`,
    );
  return build(db, () => {});
}

function build(db: Db, closeDb: () => void): SqliteIndex {
  const st = {
    versionExists: db.prepare(
      "SELECT 1 AS x FROM m3_versions WHERE workspace_id = ? AND document_id = ? AND version_id = ?",
    ),
    countVersions: db.prepare(
      "SELECT COUNT(*) AS n FROM m3_versions WHERE workspace_id = ? AND document_id = ? AND version_id != ?",
    ),
    demoteOthers: db.prepare(
      "UPDATE m3_versions SET status = 'superseded' WHERE workspace_id = ? AND document_id = ? AND version_id != ? AND status = 'active'",
    ),
    versionStatus: db.prepare(
      "SELECT status FROM m3_versions WHERE workspace_id = ? AND document_id = ? AND version_id = ?",
    ),
    oldestSuperseded: db.prepare(
      `SELECT version_id FROM m3_versions WHERE workspace_id = ? AND document_id = ?
         AND status = 'superseded' AND version_id != ? ORDER BY created_at, rowid LIMIT 1`,
    ),
    // Passages are deleted explicitly, never by the foreign-key cascade: a host connection may run with
    // foreign_keys OFF, and the index sets no pragma there.
    delVersionPassages: db.prepare("DELETE FROM m3_passages WHERE workspace_id = ? AND document_id = ? AND version_id = ?"),
    delVersion: db.prepare("DELETE FROM m3_versions WHERE workspace_id = ? AND document_id = ? AND version_id = ?"),
    insVersion: db.prepare(
      "INSERT INTO m3_versions (workspace_id, document_id, version_id, status, binding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    insPassage: db.prepare(
      "INSERT INTO m3_passages (workspace_id, document_id, version_id, passage_id, ord, page, text, binding, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    promote: db.prepare(
      "UPDATE m3_versions SET status = 'active' WHERE workspace_id = ? AND document_id = ? AND version_id = ?",
    ),
    delPassages: db.prepare("DELETE FROM m3_passages WHERE workspace_id = ? AND document_id = ?"),
    delVersions: db.prepare("DELETE FROM m3_versions WHERE workspace_id = ? AND document_id = ?"),
    stats: db.prepare(
      `SELECT (SELECT COUNT(DISTINCT document_id) FROM m3_versions WHERE workspace_id = ?1) AS documents,
              (SELECT COUNT(*) FROM m3_versions WHERE workspace_id = ?1) AS versions,
              (SELECT COUNT(*) FROM m3_passages WHERE workspace_id = ?1) AS passages`,
    ),
  };

  // after = keyset cursor (document_id, ord): one active version per document (m3_one_active) and ord unique within a
  // version make it a total order of the active passages, so pages neither overlap nor skip.
  const passagesQuery = (all: boolean, byDoc: boolean, after = false): StatementSync =>
    db.prepare(
      `SELECT p.passage_id, p.workspace_id, p.document_id, p.version_id, p.page, p.text, p.binding, p.flags, p.ord
         FROM m3_passages p
         JOIN m3_versions v ON v.workspace_id = p.workspace_id AND v.document_id = p.document_id AND v.version_id = p.version_id
        WHERE p.workspace_id = ? AND v.status = 'active'
          ${all ? "" : "AND p.binding = 1 AND v.binding = 1"}
          ${byDoc ? "AND p.document_id = ?" : ""}
          ${after ? "AND (p.document_id, p.ord) > (?, ?)" : ""}
        ORDER BY p.document_id, p.ord LIMIT ?`,
    );
  const q = {
    "0:0": passagesQuery(false, false),
    "0:1": passagesQuery(false, true),
    "1:0": passagesQuery(true, false),
    "1:1": passagesQuery(true, true),
  };
  const pages = { 0: passagesQuery(false, false, true), 1: passagesQuery(true, false, true) };

  const row = (r: Record<string, string | number>): IndexedPassage => ({
    id: r.passage_id as string,
    workspaceId: r.workspace_id as string,
    documentId: r.document_id as string,
    versionId: r.version_id as string,
    page: r.page as number,
    text: r.text as string,
    binding: r.binding === 1,
    flags: JSON.parse(r.flags as string) as PassageFlag[],
  });

  let open = true;
  const tx = <T>(fn: () => T): T => atomically(db, fn);
  const dropVersion = (ws: string, d: string, v: string): number => {
    st.delVersionPassages.run(ws, d, v);
    return Number(st.delVersion.run(ws, d, v).changes);
  };
  const live = () => {
    if (!open) throw new IndexError("closed", "index is closed");
  };

  return {
    put(doc) {
      live();
      validate(doc);
      const { workspaceId: ws, documentId: d, versionId: v } = doc;
      tx(() => {
        const prev = st.versionStatus.get(ws, d, v) as { status: string } | undefined;
        // Re-putting the active version as superseded would leave the document with no active version.
        if (prev?.status === "active" && doc.status === "superseded")
          throw new IndexError("invalid", "cannot put the active version as superseded: call supersede() with the new version");
        // Known limit: a version evicted at the version cap is forgotten, so a late put of it as active is
        // indistinguishable from a new version and becomes current. Callers must not replay evicted versions.
        // A retried or delayed put of a version that was already superseded must not resurrect it: only
        // supersede() promotes a stored version.
        const status = doc.status === "active" && prev?.status === "superseded" ? "superseded" : doc.status;
        if (status === "active") st.demoteOthers.run(ws, d, v);
        if (!prev && (st.countVersions.get(ws, d, v) as { n: number }).n >= LIMITS.versionsPerDocument) {
          // at the cap: evict the oldest superseded version; if every version is active-or-nothing, fail (rolled back)
          const oldest = st.oldestSuperseded.get(ws, d, v) as { version_id: string } | undefined;
          if (!oldest) throw new IndexError("limit", `more than ${LIMITS.versionsPerDocument} versions of one document`);
          dropVersion(ws, d, oldest.version_id);
        }
        dropVersion(ws, d, v); // re-put replaces the version and its passages
        st.insVersion.run(ws, d, v, status, doc.binding ? 1 : 0, new Date().toISOString());
        doc.passages.forEach((p, i) => {
          const flags: PassageFlag[] = [];
          if (!doc.binding) flags.push("non-binding-document");
          if (!p.binding) flags.push("non-binding-passage");
          if (looksLikeInjection(p.text)) flags.push("injection-like");
          const binding = doc.binding && p.binding && !flags.includes("injection-like");
          st.insPassage.run(ws, d, v, p.id, i, p.page, p.text, binding ? 1 : 0, JSON.stringify(flags));
        });
      });
    },

    supersede(workspaceId, documentId, newVersionId) {
      live();
      id("workspaceId", workspaceId);
      id("documentId", documentId);
      id("newVersionId", newVersionId);
      tx(() => {
        if (!st.versionExists.get(workspaceId, documentId, newVersionId))
          throw new IndexError("not_found", "no such version in this workspace");
        st.demoteOthers.run(workspaceId, documentId, newVersionId);
        st.promote.run(workspaceId, documentId, newVersionId);
      });
    },

    remove(workspaceId, documentId) {
      live();
      id("workspaceId", workspaceId);
      id("documentId", documentId);
      return tx(() => {
        st.delPassages.run(workspaceId, documentId);
        return Number(st.delVersions.run(workspaceId, documentId).changes) > 0;
      });
    },

    passagesFor(workspaceId, opts: PassagesOptions = {}) {
      live();
      id("workspaceId", workspaceId);
      const explicit = opts.limit !== undefined && Number.isFinite(opts.limit);
      const byDoc = opts.documentId !== undefined;
      const documentId = byDoc ? id("documentId", opts.documentId) : undefined;
      const key = (d: boolean) => `${opts.includeNonBinding ? 1 : 0}:${d ? 1 : 0}` as keyof typeof q;
      const read = (doc: string | undefined, limit: number) =>
        (q[key(doc !== undefined)].all(...(doc === undefined ? [workspaceId, limit] : [workspaceId, doc, limit])) as Record<string, string | number>[]).map(row);
      if (explicit) return read(documentId, Math.min(Math.max(1, Math.floor(opts.limit as number)), LIMITS.queryLimit));
      if (documentId !== undefined) {
        // one document: its active version holds at most LIMITS.passagesPerVersion (< queryLimit) passages
        const rows = read(documentId, LIMITS.queryLimit + 1);
        if (rows.length > LIMITS.queryLimit) throw new IndexError("limit", `more than ${LIMITS.queryLimit} passages in one document`);
        return rows;
      }
      // compat: no limit means every passage (it used to throw above LIMITS.queryLimit), read in keyset pages of
      // LIMITS.queryLimit rows. Every page is the same workspace-scoped, active-only (and binding-only) statement. The
      // pages share one read transaction, so a concurrent supersede or remove cannot mix two versions of a document.
      const page = pages[opts.includeNonBinding ? 1 : 0];
      const out: IndexedPassage[] = [];
      const own = !db.isTransaction;
      if (own) db.exec("BEGIN");
      let ok = false;
      try {
        let cursor: [string, number] = ["", -1];
        for (;;) {
          const rows = page.all(workspaceId, cursor[0], cursor[1], LIMITS.queryLimit) as Record<string, string | number>[];
          for (const r of rows) out.push(row(r));
          if (rows.length < LIMITS.queryLimit) break;
          const last = rows[rows.length - 1];
          cursor = [last.document_id as string, last.ord as number];
        }
        ok = true;
      } finally {
        // a failed COMMIT must not hide the original error
        if (own) {
          if (ok) {
            try {
              db.exec("COMMIT");
            } catch (e) {
              // never leave a read transaction open (on a host database it is the host's connection)
              try { db.exec("ROLLBACK"); } catch { /* keep the COMMIT error */ }
              throw e;
            }
          } else try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
        }
      }
      return out;
    },

    stats(workspaceId): IndexStats {
      live();
      id("workspaceId", workspaceId);
      const r = st.stats.get(workspaceId) as IndexStats;
      return { documents: r.documents, versions: r.versions, passages: r.passages };
    },

    close() {
      if (open) {
        open = false;
        closeDb();
      }
    },
  };
}
