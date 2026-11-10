# Owner-reserved changes for M2.3 (not applied on this branch)

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
