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
   assigns both to the firm and adds a client signature page. Proposed: pass the draft's parties to `detect()` when
   publishing from the Studio, so the block whose party is not the workspace is the client. Meanwhile, the admin
   corrects the fields on the agreement page before publishing, as for any upload.

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
