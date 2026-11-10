/** The index's own schema. See MIGRATION.md for how it would become a migration in lib/db.ts. */

/** `PRAGMA user_version` of a file opened with `openIndex(path)`. Never used on a host database. */
export const SCHEMA_VERSION = 1;

/**
 * The exact DDL of the index tables, also printed in MIGRATION.md (a test keeps the two equal). The owner pastes it
 * into a numbered migration in lib/db.ts, unchanged; `openIndexOnDatabase` then checks the stored definitions equal it.
 */
export const M3_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS m3_versions (
  workspace_id TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','superseded')),
  binding      INTEGER NOT NULL CHECK (binding IN (0,1)),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, document_id, version_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS m3_one_active
  ON m3_versions (workspace_id, document_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS m3_passages (
  workspace_id TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  passage_id   TEXT NOT NULL,
  ord          INTEGER NOT NULL,
  page         INTEGER NOT NULL CHECK (page >= 1),
  text         TEXT NOT NULL,
  binding      INTEGER NOT NULL CHECK (binding IN (0,1)),
  flags        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, document_id, version_id, passage_id),
  FOREIGN KEY (workspace_id, document_id, version_id)
    REFERENCES m3_versions (workspace_id, document_id, version_id) ON DELETE CASCADE
) STRICT;
`;

/** Every schema object (outside sqlite_*) the index creates. Anything else in a file means it is not an index file. */
export const INDEX_OBJECTS: readonly string[] = ["m3_versions", "m3_passages", "m3_one_active"];

/**
 * SQL text compared token by token: case and whitespace are ignored outside quoted literals ('active' stays
 * 'active'), and "IF NOT EXISTS" is dropped (sqlite_schema stores CREATE statements without it).
 */
export function normalizeSql(sql: string): string {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .toLowerCase()
            .replace(/\bif\s+not\s+exists\b/g, " ")
            .replace(/\s+/g, " ")
            .replace(/\s*([(),;=])\s*/g, "$1"),
    )
    .join("")
    .trim();
}

/** Each object of M3_INDEX_DDL by name, normalized: what a host database must hold exactly. */
export const EXPECTED_OBJECTS: ReadonlyMap<string, { type: "table" | "index"; sql: string }> = new Map(
  M3_INDEX_DDL.split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0)
    .map((stmt) => {
      const m = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(stmt);
      if (!m) throw new Error(`unparsed DDL statement: ${stmt.slice(0, 40)}`);
      return [m[2], { type: m[1].toLowerCase() as "table" | "index", sql: normalizeSql(stmt) }] as const;
    }),
);
