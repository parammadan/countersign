// M3's tables inside the app database (countersign.db). lib/db.ts is owner-reserved, so until the owner adds
// them as a numbered migration (docs/owner-patches/m3-migration.patch) they are created here, idempotently
// (CREATE ... IF NOT EXISTS), on the app's own connection. Nothing here reads or writes PRAGMA user_version or any
// other pragma: lib/db.ts's migration loop keeps sole control of the schema version.
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db";
import { M3_INDEX_DDL, openIndexOnDatabase } from "./index";
import type { SqliteIndex } from "./index/types";

/** Questions asked across a workspace's agreements, with the checked answer and token usage (like qa_answers). */
export const M3_QUESTIONS_DDL = `
CREATE TABLE IF NOT EXISTS m3_questions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  question      TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  mode          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  asked_by      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS m3_questions_day ON m3_questions (workspace_id, created_at);
`;

const g = globalThis as unknown as { __m3?: { db: DatabaseSync; index: SqliteIndex } };

/** Create M3's tables if missing (idempotent; no pragma). */
export function ensureSchema(conn: DatabaseSync = db()): void {
  const own = !conn.isTransaction;
  if (own) conn.exec("BEGIN IMMEDIATE");
  try {
    conn.exec(M3_INDEX_DDL);
    conn.exec(M3_QUESTIONS_DDL);
    if (own) conn.exec("COMMIT");
  } catch (e) {
    if (own) conn.exec("ROLLBACK");
    throw e;
  }
}

/** The document index on the app's connection, its tables ensured once per connection. */
export function appIndex(): SqliteIndex {
  const conn = db();
  if (g.__m3?.db !== conn) {
    ensureSchema(conn);
    g.__m3 = { db: conn, index: openIndexOnDatabase(conn) };
  }
  return g.__m3.index;
}
