# Agent task board

Cloud agents (Claude Code on the web) work from GitHub Issues. One issue is one task, owned by one agent,
on one branch, delivered as one pull request that the repository owner reviews and merges. Agents never
merge, deploy or touch production. The rules agents follow are in `CLAUDE.md` ("Rules for cloud agents");
what GitHub actually enforces is listed at the end of this file.

## Labels

| Label | Meaning | Who sets it |
|---|---|---|
| `agent:ready` | Specified, files assigned, free to claim | Owner |
| `agent:in-progress` | Claimed; an agent is working on its branch | Agent (when it claims) |
| `agent:review` | PR open, CI green, waiting for the owner | Agent |
| `agent:blocked` | The agent stopped and asked a question in the issue | Agent |
| `lane:docs`, `lane:detector-fixtures`, `lane:ui-outbox`, `lane:ui-developers` | Which lane the task belongs to | Owner |
| `owner-approved-paths` | The owner reviewed a change to a protected path (PR only) | Owner, by hand, after the last push |
| `freeze-exception` | The owner allows a merge after the submission freeze (PR only) | Owner, by hand, after the last push |

## Rules of the board

- At most **one open task per lane**, and no two open tasks may own the same path. The owner checks this
  before labelling a task `agent:ready`.
- An agent claims a task by commenting `claiming` and switching the label to `agent:in-progress`. If the
  issue is already in progress, it stops.
- Branch: `claude/T<n>-<short-slug>` from the latest `main`. Draft PR early, marked ready only when CI is green.
- An agent may change **only** the paths under "Owns". Needing anything else, especially a protected path
  (`.github/agent-guard/protected-paths.txt`), means: stop, label `agent:blocked`, explain in the issue.
- Progress notes go in the issue (one comment per session: what was done, what's next, test results).
  A session that ends unfinished leaves the branch pushed and the next step written down, so any later
  session can continue with "continue T<n> on branch claude/T<n>-...".
- After another PR merges, rebase the branch on `main` and re-run the tests before asking for review.
- The pilot runs T1 alone. T2 to T4 start only after the owner signs off the pilot.

## Lifecycle

`agent:ready` → claim → `agent:in-progress` → draft PR → tests green → `agent:review` → owner review
(pull locally, visual baselines on macOS for UI) → owner squash-merges → issue closed. Deployment stays on
the owner's local controlled path, with production verification, as before.

---

## T1: Submission documentation refresh (pilot)

- **Lane:** docs
- **Goal:** README and the submission notes describe AgreementOS as it is today on `main` (M1 steps 0 to 5:
  design system, overview dashboard, agreement library and field editor, client file workspace), with
  accurate test commands and numbers. No "formerly" or rename notes. Plain, factual, no marketing claims
  that the code doesn't back.
- **Owns:** `README.md`, `docs/SUBMISSION.md`, `docs/PLAN.md` (the "Status" section only).
- **May read:** everything else.
- **Acceptance:** every feature named exists on `main` (cite the file or test for each); every command
  shown runs as written in the cloud environment; links resolve; no real names or emails; `npx tsc
  --noEmit`, `npm run lint` and `npx vitest run` still pass (docs-only change, but proves the environment).
- **Out of scope:** code, tests, branding decisions, `CLAUDE.md`, the agent docs, screenshots.

## T2: Fresh unseen agreement set and an honest detector measurement

- **Lane:** detector-fixtures
- **Goal:** a new set of 8 synthetic client agreements the detector has never seen, with ground truth, and
  one measurement run, reported honestly. Following `CLAUDE.md`: the agent must **not open
  `lib/detect.ts`, `lib/pdf/`, `test/detect.test.ts` internals or the existing fixture sets** while writing
  the documents and ground truth (it may read `scripts/make-final.mjs` only for the output format and
  coordinate conventions described in its header).
- **Owns:** `scripts/make-next.mjs` (new), `fixtures/next/**` (new), `docs/agents/reports/T2-detector-next.md` (new).
- **Acceptance:** `node scripts/make-next.mjs` regenerates the set; `FIXTURE_DIR=fixtures/next npx vitest
  run test/detect.test.ts` is run once and its full summary (precision, recall, per-document misses) is
  copied into the report, pass or fail; all names, firms, emails and addresses are invented
  (example.com / .test).
- **Out of scope:** any change to the detector, its tests, floors or other fixture sets. A low score is a
  finding to report, not something to fix in this task.

## T3: Email log redesign (`/app/outbox`)

- **Lane:** ui-outbox
- **Goal:** the email log list and the single-email view use the M1 design system (status badges,
  readable delivery states, empty state, phone and tablet layouts), showing the same data as today.
- **Owns:** `app/app/outbox/page.tsx`, `app/app/outbox/[id]/page.tsx`, new components under
  `components/outbox/` (new), a new test `e2e/outbox.spec.ts` (new).
- **May read:** `components/ui.tsx`, `lib/email.ts`, the file page for patterns. **Must not change**
  `components/ui.tsx` (build any new piece inside `components/outbox/`), `lib/**`, `app/actions.ts`.
- **Acceptance:** the signing-link redaction and "withheld" behaviour of logged emails is unchanged and
  covered by the new test; no horizontal scroll at 360 px, Pixel 7 and iPad Mini; the existing
  accessibility checks pass; `tsc`, lint, vitest, build and the Playwright suite (minus visual) pass.
- **Out of scope:** sending, resending or changing emails; new server actions; visual baselines (the owner
  regenerates them on macOS).

## T4: Integrations & API page redesign (`/app/developers`)

- **Lane:** ui-developers
- **Goal:** the API keys, webhooks and inbound-webhook sections use the M1 design system, with clear
  copy-once secrets, empty states and phone layouts, calling the existing server actions unchanged.
- **Owns:** `app/app/developers/page.tsx`, `components/DevForms.tsx`, new components under
  `components/developers/` (new), a new test `e2e/developers.spec.ts` (new).
- **May read:** `app/actions.ts` (to call existing actions), `lib/webhooks.ts`, `components/ui.tsx`.
  **Must not change** them.
- **Acceptance:** creating and revoking an API key and adding a webhook still work end to end (new test);
  a key is shown once and never again; staff still can't reach the page; no horizontal scroll at 360 px,
  Pixel 7 and iPad Mini; accessibility checks pass; `tsc`, lint, vitest, build and Playwright (minus
  visual) pass.
- **Out of scope:** API or webhook behaviour, signing secrets, new endpoints, `app/actions.ts`.

---

## What is enforced, and by what

Instructions in `CLAUDE.md` and this file are **requests**, not a security boundary. The enforced
controls are:

| Control | Enforced by |
|---|---|
| No direct push, force-push or deletion on `main`; changes only by PR | GitHub branch protection (owner setting) |
| A PR can't merge unless `test` and `guardrails/policy` pass (source: GitHub Actions) | GitHub branch protection + `.github/workflows/agent-guard.yml` |
| Protected paths, attribution trailers, secret-looking values, real-looking emails, the submission freeze | `agent-guard` policy, run from `main` (a PR can't edit the rules that judge it) |
| No Fly or SMTP credentials, customer data or production database in reach | Not given to the cloud environment; deploys only from the owner's laptop |
| No network access to production or mail servers | The cloud environment's custom network allowlist (owner setting) |
| Claude can reach only this repository | Claude GitHub App installed on this repository only |
| No merges by agents | **Not technically enforceable** while agents act as the owner's GitHub account: required checks still pass for a correct PR. Mitigated by the deny rules in `.claude/settings.json`, the owner-only merge rule, notifications, and the pilot check of how agent actions appear on GitHub. |
| Bash and WebFetch deny rules in `.claude/settings.json` | Claude Code permission rules: friction, not a boundary (other spellings of a command aren't matched) |
