# Owner-reserved patches (M2.3 Agreement Studio and M3 Knowledge Hub)

## M2.3

1. **lib/db.ts: migration 8 = `DRAFTS_DDL_IF_NOT_EXISTS`** (`migrations-8-9.patch`). It must be the idempotent form,
   because Agreement Studio creates the same tables at first use (`lib/drafts/service.ts`, which never touches
   `PRAGMA user_version`). A plain `CREATE TABLE` would fail on any database that already ran the Studio, and
   `lib/db.ts` would rethrow on every `db()` call. The ensure step can stay; it is a no-op once the migration has
   run. Migrations apply by array position, so this lands after PR #43's migration 7 (or renumber it). The M3 branch
   (#60) has its own migration patch; whichever lands second takes the next number.
2. **lib/detect.ts: signature blocks in generated agreements.** The detector only recognises client/firm role words
   (client, customer, licensee… / provider, consultant…). For an NDA's "Disclosing Party"/"Receiving Party" blocks it
   assigns both to the firm and adds a client signature page. Done on `fix/nda-roles-unicode`: `publishDraft` passes
   the draft's parties to `ingestAgreement` and `detectFields`; when exactly one party's name is the workspace's
   (legal or display name, case and punctuation ignored), its block is the firm's and the other block the client's.
   Otherwise, and for ordinary uploads, detection is unchanged (`test/detect-parties.test.ts`).

## M3

These files are owner-reserved, so the branch doesn't edit them. Each patch applies to `main` at e3e7108 (`git apply --check` passes), compiles, and was tested with the M3 and Q&A tests applied (`test/m3-knowledge.test.ts`, `test/qa-store.test.ts`: 22/22). Apply them with `git apply docs/owner-patches/<name>.patch`.

The Knowledge Hub is correct without any of them:
- Its tables are created idempotently by `lib/m3/db.ts` `ensureSchema()` (`CREATE ... IF NOT EXISTS`, no pragma, `PRAGMA user_version` untouched).
- It only serves an agreement at its current version while the agreement isn't archived (`lib/m3/store.ts` `currentOnly`). Without the hooks, a newly published or restored agreement isn't searchable until someone clicks "Index agreements" or "Re-index".

| patch | file | what |
|---|---|---|
| `m3-migration.patch` | `lib/db.ts` | Adds the next migration (7 on main): `M3_INDEX_DDL` verbatim (`m3_versions`, `m3_one_active`, `m3_passages`), plus `m3_questions` and its index. `IF NOT EXISTS` makes it a no-op where `ensureSchema` already created them. If another migration (e.g. M2.3) lands first, keep this as the last entry. After it lands, `ensureSchema` can stay as is or be removed. |
| `m3-publish-reindex.patch` | `lib/templates.ts` | `publishVersion` re-indexes the agreement at its new version (best effort, a dynamic import, errors swallowed). |
| `m3-archive-restore.patch` | `app/actions.ts` | Archive removes the agreement from the index; restore indexes it again (best effort). |

The DDL must stay identical to `M3_INDEX_DDL`: `openIndexOnDatabase` compares the stored definitions with it (case and whitespace aside) and refuses a different one with `IndexError("schema_missing")`.

## Clause Library

The Clause Library (`lib/clauses`, `/app/clauses`) is correct without the patch:
- `lib/clauses/sqlite-store.ts` creates its tables and triggers idempotently (`CREATE ... IF NOT EXISTS`) at first use on the app's own connection.
- It sets no pragma on that connection and never touches `PRAGMA user_version`.

| patch | file | what |
|---|---|---|
| `clause-library-migration.patch` | `lib/db.ts` | Appends `CLAUSES_DDL` (imported from `lib/clauses/sqlite-store`, so it can't drift) as the next migration: `clause_library_clauses`, `clause_library_versions` and their five immutability triggers. Because it is `IF NOT EXISTS`, it is a no-op on a database that already used the Clause Library. If M2.3's or M3's migration lands first, keep this one last. |

How it was checked:
- `git apply --check` passes on this branch.
- With the patch applied, `npx tsc --noEmit` is clean and `test/clauses/app.test.ts` passes (18/18): the migration runs at open, then the first-use creation is a no-op.
