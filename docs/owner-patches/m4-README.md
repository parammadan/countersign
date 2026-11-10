# Owner-reserved patches (M4 Document Intelligence and the internal workflow outbox)

These files are owner-reserved, so the branch doesn't edit them. Each patch applies to `main` at 8393410 (`git apply --check`
passes) and compiles. With `m4-intake-workflow-migration.patch` applied, `test/intake/service.test.ts`,
`test/intake/actions.test.ts` and `test/m3-knowledge.test.ts` pass (28/28).

Document Intelligence and the workflow events page are correct without any of them:
- `intake_results` is created idempotently at first use by `lib/intake/store.ts` `ensureIntakeSchema()`, and the outbox
  tables (`wf_*`) by `lib/workflow/outbox.ts` (`OUTBOX_DDL`, run by the app outbox in `lib/workflow/app.ts`). Both use
  `CREATE ... IF NOT EXISTS`, set no pragma on the app connection and never touch `PRAGMA user_version`.
- Agreement Studio events (submitted, approved, changes requested, published) are recorded from the Studio's own approval
  log (`draft_approvals`), idempotently, each time the Workflow events page is opened.

| patch | file | what |
|---|---|---|
| `m4-intake-workflow-migration.patch` | `lib/db.ts` | Adds the next migration (after M2.2's `qa_answers`): the same statements as `INTAKE_DDL` and `OUTBOX_DDL`, `IF NOT EXISTS`, so it is a no-op where the app already created them. If the M2.3 (`migrations-8-9.patch`) or M3 (`m3-migration.patch`) migrations land first, keep this as the last entry. |
| `m4-studio-events.patch` | `app/studio-actions.ts` | After a successful submit, approve, request-changes or publish, records the workflow event immediately (`syncStudioEvents`, idempotent, errors swallowed), instead of on the next view of the Workflow events page. |

External webhook delivery stays disabled: `lib/workflow/app.ts` builds the outbox with the in-memory transport and
`externalDelivery: false`, records every event with no targets (so there are no deliveries), refuses every DNS lookup and
has no signing secret. Turning delivery on needs a network transport that meets `TransportContract`
(`lib/workflow/types.ts`), per-workspace targets and secrets, and `externalDelivery: true`: none of that is in this branch.

Uploads: server actions accept bodies up to 2 MB (`next.config.ts`, `experimental.serverActions.bodySizeLimit`), so
Document Intelligence reads files up to 1.9 MB (agreement uploads go through `app/api/agreements/upload` at 20 MB). To
read larger files, raise that limit or add an upload route (both owner-reserved).
