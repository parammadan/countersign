# Owner-reserved changes for M2.3 (not applied on this branch)

1. **lib/db.ts, migration 8 = `DRAFTS_DDL`** (`migrations-8-9.patch`). Until it lands, `lib/drafts/service.ts` creates
   the same tables with `DRAFTS_DDL_IF_NOT_EXISTS` at first use. That never touches `PRAGMA user_version`. Once the
   migration lands, delete the ensure step. Migrations apply by array position, so this lands only after PR #43's
   migration 7, or with that migration renumbered.
2. **lib/detect.ts: signature blocks in generated agreements.** The detector only recognises client/firm role words
   (client, customer, licensee… / provider, consultant…). For an NDA's "Disclosing Party"/"Receiving Party" blocks it
   assigns both to the firm and adds a client signature page. Proposed: pass the draft's parties to `detect()` when
   publishing from the Studio, so the block whose party is not the workspace is the client. Meanwhile, the admin
   corrects the fields on the agreement page before publishing, as for any upload.
