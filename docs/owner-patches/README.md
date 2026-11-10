# Owner patches for the M3 Knowledge Hub

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
