import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IndexError, LIMITS, M3_INDEX_DDL, openIndex, openIndexOnDatabase } from "../lib/m3/index";
import type { IndexedDocument, SqliteIndex } from "../lib/m3/index/types";

const doc = (o: Partial<IndexedDocument> & { texts?: string[] } = {}): IndexedDocument => ({
  workspaceId: "ws-a",
  documentId: "doc-1",
  versionId: "v1",
  status: "active",
  binding: true,
  passages: (o.texts ?? ["Payment is due in 30 days.", "Either party may terminate on notice."]).map((text, i) => ({
    id: `p${i + 1}`,
    page: i + 1,
    text,
    binding: true,
  })),
  ...o,
});

const APP_TABLES = ["users", "workspaces", "members", "files", "documents"];

/** An app-like database: WAL, foreign keys on, its own tables and rows, migrated to user_version 6. */
function appDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1234;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE members (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id));
    CREATE TABLE files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), bytes BLOB);
    CREATE TABLE documents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT);
    CREATE INDEX documents_ws ON documents (workspace_id);
    INSERT INTO users VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com');
    INSERT INTO workspaces VALUES ('ws-a', 'A'), ('ws-b', 'B');
    INSERT INTO members VALUES ('ws-a', 'u1', 'owner'), ('ws-b', 'u2', 'owner');
    INSERT INTO files VALUES ('f1', 'ws-a', x'00ff'), ('f2', 'ws-b', x'0102');
    INSERT INTO documents VALUES ('doc-1', 'ws-a', 'MSA'), ('doc-2', 'ws-b', 'NDA');
    PRAGMA user_version = 6;`);
  return db;
}

const one = (db: DatabaseSync, sql: string) => Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];

/** What is stored in the host file and must not change: user_version, journal mode, schema outside m3_*, every app row. */
function fileState(db: DatabaseSync) {
  return {
    userVersion: one(db, "PRAGMA user_version"),
    journalMode: one(db, "PRAGMA journal_mode"),
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name NOT LIKE 'm3\\_%' ESCAPE '\\' ORDER BY name").all(),
    rows: Object.fromEntries(APP_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])),
    counts: Object.fromEntries(APP_TABLES.map((t) => [t, one(db, `SELECT COUNT(*) FROM ${t}`)])),
  };
}

/** fileState plus the host connection's own settings, which the index must not change either. */
function hostState(db: DatabaseSync) {
  return {
    ...fileState(db),
    foreignKeys: one(db, "PRAGMA foreign_keys"),
    secureDelete: one(db, "PRAGMA secure_delete"),
    busyTimeout: one(db, "PRAGMA busy_timeout"),
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IndexError);
    return (e as IndexError).code;
  }
  return undefined;
}

/** The host connection, with every SQL string the index sends through it recorded. */
function spied(db: DatabaseSync): { db: DatabaseSync; sql: string[] } {
  const sql: string[] = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare" || key === "exec")
        return (s: string) => {
          sql.push(s);
          return key === "prepare" ? target.prepare(s) : target.exec(s);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, sql };
}

let dir: string;
let path: string;
let host: DatabaseSync;
let idx: SqliteIndex | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m3-host-"));
  path = join(dir, "app.db");
  host = appDb(path);
  idx = undefined;
});
afterEach(() => {
  idx?.close();
  if (host.isOpen) host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openIndexOnDatabase on a host database", () => {
  it("refuses (schema_missing) when the host's migration has not created the tables, and changes nothing", () => {
    const before = hostState(host);
    expect(codeOf(() => openIndexOnDatabase(host))).toBe("schema_missing");
    expect(codeOf(() => openIndexOnDatabase(host, { create: false }))).toBe("schema_missing");
    expect(() => openIndexOnDatabase(host)).toThrow(/M3_INDEX_DDL/);
    expect(hostState(host)).toEqual(before);
    expect(host.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'm3%'").get()).toEqual({ n: 0 });
  });

  it("works after the DDL is applied, and leaves user_version, pragmas, app schema and app rows untouched", () => {
    host.exec(M3_INDEX_DDL); // what the owner's migration does
    const before = hostState(host);
    expect(before.userVersion).toBe(6);
    const { db, sql } = spied(host);
    idx = openIndexOnDatabase(db);
    idx.put(doc());
    idx.put(doc({ versionId: "v2", texts: ["Payment is due in 45 days."] }));
    idx.put(doc({ documentId: "ref", binding: false, texts: ["Reference only."] }));
    idx.put(doc({ workspaceId: "ws-b", documentId: "doc-2", texts: ["Other tenant."] }));
    expect(idx.passagesFor("ws-a").map((p) => `${p.documentId}@${p.versionId}:${p.text}`)).toEqual(["doc-1@v2:Payment is due in 45 days."]);
    expect(idx.passagesFor("ws-a", { includeNonBinding: true }).map((p) => p.documentId)).toEqual(["doc-1", "ref"]);
    expect(idx.passagesFor("ws-b").every((p) => p.workspaceId === "ws-b")).toBe(true);
    expect(idx.passagesFor("ws-c")).toEqual([]);
    idx.supersede("ws-a", "doc-1", "v1");
    expect(idx.passagesFor("ws-a", { documentId: "doc-1" }).map((p) => p.versionId)).toEqual(["v1", "v1"]);
    expect(() => idx!.supersede("ws-b", "doc-1", "v1")).toThrow(IndexError); // other workspace's version
    expect(idx.stats("ws-a")).toEqual({ documents: 2, versions: 3, passages: 4 });
    expect(idx.remove("ws-a", "doc-1")).toBe(true);
    expect(idx.stats("ws-a")).toEqual({ documents: 1, versions: 1, passages: 1 });
    expect(Object.keys(idx).sort()).toEqual(["close", "passagesFor", "put", "remove", "stats", "supersede"]);
    idx.close();
    expect(() => idx!.passagesFor("ws-a")).toThrow(/closed/);
    idx = undefined;

    expect(hostState(host)).toEqual(before);
    // no pragma statement and no user_version access went through the host connection
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.filter((s) => /\bpragma\s/i.test(s) || /user_version|journal_mode/i.test(s))).toEqual([]);
    // the host connection stays open and usable after the index is closed
    expect(host.isOpen).toBe(true);
    expect(host.prepare("SELECT COUNT(*) AS n FROM m3_passages WHERE workspace_id = 'ws-b'").get()).toEqual({ n: 1 });
  });

  it("create: true applies the DDL without touching user_version or app tables, and is idempotent", () => {
    const before = hostState(host);
    idx = openIndexOnDatabase(host, { create: true });
    idx.put(doc());
    idx.close();
    idx = openIndexOnDatabase(host, { create: true });
    expect(idx.passagesFor("ws-a")).toHaveLength(2);
    expect(hostState(host)).toEqual(before);
    expect(host.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  });

  it("refuses a partial or different schema", () => {
    const variants: [string, RegExp][] = [
      [M3_INDEX_DDL.replace(/CREATE UNIQUE INDEX[^;]*;/, ""), /index m3_one_active is missing/],
      [M3_INDEX_DDL.replace("CREATE UNIQUE INDEX", "CREATE INDEX"), /index m3_one_active differs/],
      [M3_INDEX_DDL.replace("WHERE status = 'active'", "WHERE status = 'superseded'"), /index m3_one_active differs/],
      // the literal is compared as written: an index on 'ACTIVE' never matches a row and enforces nothing
      [M3_INDEX_DDL.replace("WHERE status = 'active'", "WHERE status = 'ACTIVE'"), /index m3_one_active differs/],
      [M3_INDEX_DDL.replace("  flags        TEXT NOT NULL,\n", ""), /table m3_passages differs/],
      [M3_INDEX_DDL.replace(/CREATE TABLE IF NOT EXISTS m3_passages[\s\S]*?\) STRICT;/, ""), /table m3_passages is missing/],
      [M3_INDEX_DDL.replace("PRIMARY KEY (workspace_id, document_id, version_id)\n", "PRIMARY KEY (document_id, version_id, workspace_id)\n"), /table m3_versions differs/],
      // a case-insensitive workspace id would serve tenant "Acme" to "ACME"
      [M3_INDEX_DDL.replace("workspace_id TEXT NOT NULL,", "workspace_id TEXT NOT NULL COLLATE NOCASE,"), /table m3_versions differs/],
      // not STRICT with a TEXT ord sorts p10 before p2 and breaks the keyset cursor
      [M3_INDEX_DDL.replace("  ord          INTEGER NOT NULL,", "  ord          TEXT NOT NULL,").replace(/\) STRICT;\s*$/, ");"), /table m3_passages differs/],
      [M3_INDEX_DDL.replace(") STRICT;\n\nCREATE UNIQUE", ") STRICT, WITHOUT ROWID;\n\nCREATE UNIQUE"), /table m3_versions differs/],
    ];
    for (const [ddl, msg] of variants) {
      expect(ddl).not.toBe(M3_INDEX_DDL);
      const db = new DatabaseSync(":memory:");
      db.exec(ddl);
      expect(codeOf(() => openIndexOnDatabase(db))).toBe("schema_missing");
      expect(() => openIndexOnDatabase(db)).toThrow(msg);
      db.close();
    }
    // whitespace and keyword case of the pasted DDL do not matter
    const reformatted = new DatabaseSync(":memory:");
    reformatted.exec(M3_INDEX_DDL.replace(/\n\s*/g, " ").replace(/CREATE TABLE/g, "create table"));
    openIndexOnDatabase(reformatted).close();
    // a TEMP table of the same name would shadow the real one for the index's statements
    reformatted.exec("CREATE TEMP TABLE m3_versions (x)");
    expect(() => openIndexOnDatabase(reformatted)).toThrow(/temp object m3_versions/);
    reformatted.close();
    expect(codeOf(() => openIndexOnDatabase(reformatted))).toBe("invalid"); // closed
    expect(codeOf(() => openIndexOnDatabase(null as unknown as DatabaseSync))).toBe("invalid");
  });

  it("removes passages itself when the host runs with foreign_keys OFF (no orphans after re-put, remove, eviction)", () => {
    host.exec("PRAGMA foreign_keys = OFF");
    host.exec(M3_INDEX_DDL);
    idx = openIndexOnDatabase(host);
    const orphans = () =>
      host.prepare(`SELECT COUNT(*) AS n FROM m3_passages p WHERE NOT EXISTS (SELECT 1 FROM m3_versions v
        WHERE v.workspace_id = p.workspace_id AND v.document_id = p.document_id AND v.version_id = p.version_id)`).get();
    idx.put(doc());
    idx.put(doc({ texts: ["replaced"] })); // re-put of v1
    expect(idx.stats("ws-a").passages).toBe(1);
    for (let i = 0; i < LIMITS.versionsPerDocument; i++) idx.put(doc({ versionId: `e${i}`, texts: ["t"] }));
    expect(idx.stats("ws-a").versions).toBe(LIMITS.versionsPerDocument);
    expect(idx.stats("ws-a").passages).toBe(LIMITS.versionsPerDocument);
    expect(orphans()).toEqual({ n: 0 });
    expect(idx.remove("ws-a", "doc-1")).toBe(true);
    expect(host.prepare("SELECT COUNT(*) AS n FROM m3_passages").get()).toEqual({ n: 0 });
    expect(host.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
  });

  it("joins an open host transaction through a savepoint: a failed put is undone, the host's work is kept", () => {
    host.exec(M3_INDEX_DDL);
    // fails a put after it has demoted v1 and inserted v2's first passage
    host.exec(`CREATE TRIGGER fail_put BEFORE INSERT ON m3_passages WHEN NEW.text = 'boom'
      BEGIN SELECT RAISE(ABORT, 'host trigger'); END`);
    idx = openIndexOnDatabase(host);
    host.exec("BEGIN");
    host.exec("INSERT INTO users VALUES ('u3', 'c@example.com')");
    idx.put(doc());
    expect(() => idx!.put(doc({ versionId: "v2", texts: ["first", "boom"] }))).toThrow(/host trigger/);
    expect(host.isTransaction).toBe(true); // the host's transaction is still open
    expect(idx.passagesFor("ws-a").map((p) => p.versionId)).toEqual(["v1", "v1"]); // v1 still active, no v2 rows
    expect(idx.stats("ws-a")).toEqual({ documents: 1, versions: 1, passages: 2 });
    expect(host.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 3 }); // host's own insert kept
    host.exec("ROLLBACK");
    expect(idx.passagesFor("ws-a")).toEqual([]);
    expect(host.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
    // outside a host transaction the same failure rolls back fully and leaves no transaction open
    idx.put(doc());
    expect(() => idx!.put(doc({ versionId: "v2", texts: ["first", "boom"] }))).toThrow(/host trigger/);
    expect(host.isTransaction).toBe(false);
    expect(idx.stats("ws-a")).toEqual({ documents: 1, versions: 1, passages: 2 });
  });

  it("MIGRATION.md prints exactly M3_INDEX_DDL", () => {
    const md = readFileSync(join(__dirname, "../lib/m3/index/MIGRATION.md"), "utf8");
    const block = /```sql\n([\s\S]*?)```/.exec(md)?.[1];
    expect(block?.trim()).toBe(M3_INDEX_DDL.trim());
  });
});

describe("openIndex(path) refuses an app database", () => {
  it("refuses an app database (user_version 6, app tables) with a typed error and writes nothing", () => {
    const before = fileState(host);
    host.close();
    const size = statSync(path).size;
    expect(codeOf(() => openIndex(path))).toBe("not_index_database");
    expect(() => openIndex(path)).toThrow(/table documents/);
    host = new DatabaseSync(path);
    expect(fileState(host)).toEqual(before);
    expect(host.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'm3%'").get()).toEqual({ n: 0 });
    host.close();
    expect(statSync(path).size).toBe(size);
  });

  it("refuses a user_version-0 file with a workspaces table, a foreign table next to the index, and odd user_versions", () => {
    host.close();
    const cases: [string, string][] = [
      ["CREATE TABLE workspaces (id TEXT PRIMARY KEY);", "not_index_database"],
      [`${M3_INDEX_DDL} PRAGMA user_version = 1; CREATE TABLE users (id TEXT);`, "not_index_database"],
      [`${M3_INDEX_DDL} CREATE VIEW m3_all AS SELECT * FROM m3_passages;`, "not_index_database"],
      ["PRAGMA user_version = -3;", "not_index_database"],
      ["PRAGMA user_version = 6;", "schema"],
    ];
    cases.forEach(([setup, code], i) => {
      const p = join(dir, `case${i}.db`);
      const raw = new DatabaseSync(p);
      raw.exec(setup);
      const uv = raw.prepare("PRAGMA user_version").get();
      raw.close();
      expect(codeOf(() => openIndex(p))).toBe(code);
      const again = new DatabaseSync(p);
      expect(again.prepare("PRAGMA user_version").get()).toEqual(uv);
      again.close();
    });
  });

  it("still opens an empty file and its own index file", () => {
    host.close();
    const p = join(dir, "index.db");
    idx = openIndex(p);
    idx.put(doc());
    idx.close();
    idx = openIndex(p);
    expect(idx.passagesFor("ws-a")).toHaveLength(2);
    const raw = new DatabaseSync(p);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    raw.close();
  });
});
