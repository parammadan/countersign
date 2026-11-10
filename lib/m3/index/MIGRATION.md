# M3 index: storage and migration notes

**In AgreementOS (countersign):** the Knowledge Hub uses `openIndexOnDatabase` on the app's own connection. `lib/m3/db.ts` `ensureSchema()` creates these tables idempotently, never touching `PRAGMA user_version`, until the owner migration in `docs/owner-patches/m3-migration.patch` lands. Ported from the reviewed sandbox (agreementos-agents #67, #73).

Two ways to open the index. Both have the same API (`put`/`supersede`/`remove`/`passagesFor`/`stats`/`close`), the
same workspace scoping and the same active-only / binding-only filters.

## `openIndex(path)`: a file of its own (tests, local tools)

The index keeps its own SQLite file (tables `m3_versions` and `m3_passages`, `PRAGMA user_version = 1`) on a path the
caller injects (tests use a temp dir). It sets `foreign_keys`, `secure_delete` and `busy_timeout` on its own connection.

It refuses, with `IndexError("not_index_database")`, any file that holds a schema object other than the index
(`m3_versions`, `m3_passages`, `m3_one_active`; e.g. a `users`, `files` or `workspaces` table), or whose
`user_version` is negative; a `user_version` above `SCHEMA_VERSION` throws `IndexError("schema")` as before. The
check runs read-only before anything is written and again under the write lock, so pointing `openIndex` at the app's
database (lib/db.ts) once it has been migrated leaves it untouched instead of stamping `user_version = 1` on it, which
would make the app re-run its migrations from 2 and fail. Not covered: an app database path that does not exist yet or
is still empty (no tables, `user_version` 0) looks exactly like a new index file, so `openIndex` would create the index
there and stamp `user_version = 1`, and lib/db.ts would then skip its first migration. Never give `openIndex` the app's
database path; use `openIndexOnDatabase`.

## `openIndexOnDatabase(db, { create? })`: inside the app database (production)

1. Add this DDL (exported as `M3_INDEX_DDL` from `modules/m3-index`; a test keeps this block equal to it) unchanged as
   one numbered migration in `lib/db.ts`. Both tables are `STRICT` and independent of every existing table. Whitespace and
   keyword case may differ; anything else (a `REFERENCES workspaces`, a collation, a type) needs the same change in
   `M3_INDEX_DDL`, because the index refuses a definition that differs from it.

```sql
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
```

2. Open the index on the app's connection: `openIndexOnDatabase(db)`. It never reads or writes `PRAGMA user_version`
   and sets no pragma (`journal_mode`, `foreign_keys`, `secure_delete`, `busy_timeout` stay the app's choice). With
   `create` false (the default) it only reads `sqlite_schema` and checks that `m3_versions`, `m3_passages` and
   `m3_one_active` exist with exactly the definitions above (compared with case and whitespace ignored outside quoted
   literals) and that no TEMP object shadows them; otherwise it throws `IndexError("schema_missing")` naming each
   problem. A changed collation, type, `STRICT` or index predicate could otherwise weaken workspace isolation or the
   one-active-version rule. `create: true` runs
   the DDL first (`IF NOT EXISTS`); it is for tests and local tools, not for the app, whose migration owns the schema.
   Writes use `BEGIN IMMEDIATE`, or a savepoint inside a transaction the app already opened. `close()` stops the index
   and leaves the app's connection open.
3. Deleting passages does not rely on the `ON DELETE CASCADE`: the index deletes them itself, so it is correct with
   `foreign_keys` OFF. Real erasure of deleted text from the file needs `PRAGMA secure_delete = ON` on the app's
   connection; that is the owner's decision (the index does not set it on a host connection).
4. Backfill: re-`put` the active version of each stored document; nothing else is derived.
5. Rollback: `DROP TABLE m3_passages; DROP TABLE m3_versions;` is lossless because the index is rebuildable from documents.

Future schema changes of the index: on its own file, bump `SCHEMA_VERSION` and add an `if (current < N)` step in
`openIndex`; in the app database, a new app migration plus the matching change to `M3_INDEX_DDL`.

## Semantics

One active version per document (partial unique index); `put` of an active version demotes the previous one in the same
transaction; `remove` hard-deletes versions and passages (no tombstone, no text retained); every statement is filtered
by `workspace_id`, and there is no exported way to query without one. Ranking is deliberately absent; S5 ranks the
passages `passagesFor` returns.
