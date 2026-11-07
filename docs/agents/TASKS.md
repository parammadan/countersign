# Agent task board

Cloud agents (Claude Code on the web) work from GitHub Issues. One issue is one task, owned by one agent, on
one branch, delivered as one pull request that the repository owner reviews and merges. Agents never merge,
deploy or touch production. The rules agents follow are in `CLAUDE.md` ("Rules for cloud agents"); what is
actually enforced is listed at the end of this file. Nothing here starts without the owner's go-ahead.

## Queue and rollout

| Order | Task | Lane | Est. agent time | Starts when |
|---|---|---|---|---|
| Pilot | **Q1** Submission documentation | `lane:docs` | 1.5–2 h | owner approves the pilot (alone) |
| Wave 1 | **Q2** Unseen agreement set + honest detector score | `lane:detector` | 2–3 h | pilot signed off |
| Wave 1 | **Q4** API reference | `lane:api-docs` | 1.5–2.5 h | pilot signed off |
| Wave 1 | **Q5** Email log redesign | `lane:ui-outbox` | 2–3 h | pilot signed off |
| Wave 2 | **Q3** Client files list redesign | `lane:ui-files` | 2–3 h | a wave-1 slot frees up |
| Wave 2 | **Q6** Integrations & API page redesign | `lane:ui-developers` | 2.5–3.5 h | a slot frees up (Q4 merged first is better) |
| Wave 2 | **Q7** Sign-in and account pages polish | `lane:ui-auth` | 2.5–3.5 h | a slot frees up |
| Last | **Q8** Accessibility and UX audit (report only) | `lane:audit` | 1–2 h | Q3, Q5, Q6, Q7 merged |

- At most **three tasks in progress at once**, at most one per lane, and no two in-progress tasks may own the same path.
- **No new task starts in the 24 hours before the submission freeze** (`AGENT_FREEZE_AT`), and nothing is
  pushed after it.
- Owner-only, not agent work: deploys and production checks, the duplicate-send race fix, the Settings page,
  the signing room, anything on `.github/agent-guard/protected-paths.txt`, and any M2 / AI work.

## Labels

| Label | Meaning | Who sets it |
|---|---|---|
| `agent:ready` | Specified and free to claim | Owner |
| `agent:in-progress` | Claimed; an agent is working on its branch | Agent |
| `agent:review` | PR open, CI green, waiting for the owner | Agent |
| `agent:blocked` | The agent stopped and asked a question in the issue | Agent |
| `lane:*` | The task's lane (one per task, see the queue) | Owner |
| `owner-approved-paths` | The owner reviewed a change to a protected path (PR only) | Owner, by hand, after the last push |
| `freeze-exception` | The owner allows a merge after the freeze (PR only) | Owner, by hand, after the last push |

## How an agent works a task

1. Read `CLAUDE.md`, `AGENTS.md` and the issue. Comment `claiming` and switch the label to
   `agent:in-progress`; if it's already in progress, stop.
2. Branch `claude/Q<n>-<slug>` from the latest `main`. Change **only** the paths under "Owns".
3. `npm ci`, then before every push: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`,
   `npx playwright install chromium` (once) and `PW_CHANNEL=chromium npx playwright test`. Visual tests skip
   themselves; don't update or commit snapshots.
4. Draft PR from the template early; mark it ready, and label the issue `agent:review`, only when CI is green.
5. End of every session: a comment in the issue with what changed, the test results and the next step.
   An unfinished session leaves the branch pushed, so a later session can "continue Q<n> on branch …".
6. Needing a path outside "Owns", or any protected path: stop, label `agent:blocked`, explain.
7. After another PR merges: rebase on `main`, re-run the tests.

The owner reviews (pulling UI work locally and regenerating macOS visual baselines where screenshots
change), squash-merges, closes the issue, and deploys only through the local controlled path with
production verification.

## Field names other tests depend on

`e2e/helpers.ts` (protected) drives the app by accessible names. UI tasks must keep these exactly:
sign-up "Firm name", "Legal entity name", "Your name", "Work email", "Password", "Create workspace";
sign-in "Work email", "Password", "Sign in", "Sign out"; invite "Your name", "Choose a password",
"Join workspace"; forgot "Work email", "Email me a reset link"; reset "New password", "Save and sign in";
"Confirm my email"; files "Client full name", "Client email", "File / matter reference",
"Create and send for signature", "Copy signing link"; settings placeholders "Full name",
"Managing Partner", "colleague@example.com" and buttons "Adopt signature", "Save settings", "Invite".

---

## Q1: Submission documentation (pilot)

- **Owns:** `README.md`, `docs/SUBMISSION.md`, and the "Status" section of `docs/PLAN.md`.
- **Depends on:** nothing.
- **Goal:** the docs describe AgreementOS as it is on `main` today (M1 steps 0–5: design system, overview,
  agreement library and editor, client file workspace), with accurate commands and numbers, no rename notes,
  and no claims the code doesn't back.
- **Acceptance:** every feature named cites the file or test that implements it; every command shown runs as
  written in the cloud environment; links resolve; synthetic names only.
- **Tests:** `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (docs-only, but proves the environment works).

## Q2: Unseen agreement set and an honest detector score

- **Owns:** `scripts/make-next.mjs` (new), `fixtures/next/**` (new), `docs/agents/reports/Q2-detector-next.md` (new).
- **Depends on:** nothing.
- **Goal:** eight new synthetic client agreements with ground truth that the detector has never seen, and one
  measurement, reported as it comes out. While writing them the agent must **not open `lib/detect.ts`,
  `lib/pdf/`, the existing fixture sets or `test/detect.test.ts` beyond running it**; it may read only the
  header comment of `scripts/make-final.mjs` for the file format and coordinate conventions.
- **Acceptance:** `node scripts/make-next.mjs` regenerates the set; the report contains the full output of one
  `FIXTURE_DIR=fixtures/next npx vitest run test/detect.test.ts` run (precision, recall, misses per document).
  That run passes by construction (a new folder has no floor), so the numbers are the result. All people,
  firms, emails and addresses invented (example.com / .test).
- **Tests:** the measurement run above, plus `npx vitest run` and `npm run lint`.
- **Out of scope:** any change to the detector, its tests, floors or other fixture sets. A low score is a
  finding to report, not to fix.

## Q3: Client files list redesign (`/app/files`)

- **Owns:** `app/app/files/page.tsx`, `components/FileTable.tsx`, `components/files/**` (new), `e2e/files-list.spec.ts` (new).
- **Must not change:** `components/ResetForms.tsx` (owned by Q7, used by this page for CSV import),
  `app/app/files/new/**`, `app/app/files/[id]/**`.
- **Depends on:** nothing, but `FileTable` is shared with the overview page, so the overview must keep working.
- **Goal:** the M1 design system on the list: tabs, search, status badges, empty and no-results states,
  phone and tablet layouts, the same data and links as today.
- **Acceptance:** tabs and search return the same files as before (new test); `e2e/overview.spec.ts` still
  passes unchanged; no sideways scroll at 360 px, Pixel 7 and iPad Mini; the accessibility checks pass.
- **Tests:** full suite minus visual. The owner regenerates the overview screenshot on macOS.

## Q4: API reference

- **Owns:** `docs/API.md` (new), `public/openapi.json` (new), `test/openapi.test.ts` (new).
- **May read:** `app/api/**`, `lib/schemas.ts`, `lib/files.ts` (`fileJson`), `lib/webhooks.ts`.
- **Depends on:** nothing.
- **Goal:** a complete, accurate reference for the public API (`/api/v1/*`), the inbound webhook and the
  outbound webhook events, signatures and retries, for integrators (n8n included).
- **Acceptance:** every route file under `app/api/v1` has an entry; request and response fields match the
  code; `test/openapi.test.ts` fails if a route file exists with no spec entry, or the JSON isn't valid OpenAPI 3.
- **Tests:** `npx vitest run`, `npm run lint`, `npx tsc --noEmit`.
- **Out of scope:** any change to the API, schemas or webhooks.

## Q5: Email log redesign (`/app/outbox`)

- **Owns:** `app/app/outbox/page.tsx`, `app/app/outbox/[id]/page.tsx`, `components/outbox/**` (new), `e2e/outbox.spec.ts` (new).
- **Must not change:** `components/ui.tsx`, anything under `lib/`.
- **Depends on:** nothing.
- **Goal:** list and detail views in the M1 design system: clear delivery states (delivered, failed with
  reason, logged only), filtering by status, empty state, phone and tablet layouts.
- **Acceptance:** signing links stay redacted and the "withheld" note stays (new test asserts the token
  never appears); no sideways scroll at 360 px, Pixel 7 and iPad Mini; the accessibility checks pass.
- **Tests:** full suite minus visual.
- **Out of scope:** sending or resending email, new server actions.

## Q6: Integrations & API page redesign (`/app/developers`)

- **Owns:** `app/app/developers/page.tsx`, `components/DevForms.tsx`, `components/developers/**` (new), `e2e/developers.spec.ts` (new).
- **May read:** `app/actions.ts` (to call the existing actions), `lib/webhooks.ts`, `components/ui.tsx`.
- **Depends on:** nothing; if Q4 has merged, link to `docs/API.md`.
- **Goal:** API keys, outbound webhooks and the inbound webhook in the M1 design system, with copy-once
  secrets, empty states and phone layouts, using the existing server actions unchanged.
- **Acceptance:** create and revoke a key, add a webhook and see a delivery, all end to end (new test); a new
  key is shown once and never again; staff still can't open the page; layouts and accessibility as above.
- **Tests:** full suite minus visual, including `e2e/webhook.spec.ts` unchanged.

## Q7: Sign-in and account pages polish

- **Owns:** `app/login/page.tsx`, `app/signup/page.tsx`, `app/forgot/page.tsx`, `app/reset/[token]/page.tsx`,
  `app/invite/[token]/page.tsx`, `app/confirm-email/**/page.tsx`, `components/AuthForms.tsx`,
  `components/ResetForms.tsx`, `components/auth/**` (new), `e2e/auth-pages.spec.ts` (new).
- **Must not change:** `app/actions.ts`, `lib/auth.ts`, `lib/emailverify.ts`, `lib/ratelimit.ts`.
- **Depends on:** nothing; Q3 must not be editing `ResetForms.tsx` at the same time (it doesn't own it).
- **Goal:** the sign-in, sign-up, password-reset, invitation and email-confirmation pages in the M1 design
  system, with clear errors, loading states and phone layouts, and identical behaviour.
- **Acceptance:** every accessible name in "Field names other tests depend on" is unchanged; the whole
  existing suite passes untouched; wrong-password, expired-link and already-used-invite states are shown and
  tested; layouts and accessibility as above.
- **Tests:** full suite minus visual. The owner regenerates the login and signup screenshots on macOS.

## Q8: Accessibility and UX audit (report only)

- **Owns:** `docs/agents/reports/Q8-audit.md` (new).
- **Depends on:** Q3, Q5, Q6 and Q7 merged.
- **Goal:** a prioritised list of accessibility and usability problems across every page (axe results plus
  a manual pass: keyboard order, focus, contrast, labels, phone layouts), each with file and line, severity,
  and a suggested fix, to become the next tasks.
- **Acceptance:** covers every route in `app/`; no code changes.
- **Tests:** `npx playwright test e2e/a11y.spec.ts` results quoted in the report.

---

## What is enforced, and by what (GitHub Free)

This repository is private on GitHub Free, so **branch protection and rulesets are not available**: GitHub
can't require pull requests, required checks or block force-pushes here. Anything with write access to this
repository can push to `main` or merge. Prompts, `CLAUDE.md` and the cloud hook **do not prevent** that.

So cloud agents get **no access to this repository at all**:

- They work in a separate private **sandbox repository** (`parammadan/agreementos-agents`), a copy of `main`.
  The Claude GitHub App is installed on the sandbox only; `/web-setup` (which shares the owner's `gh` token
  and so reaches every repository) is never used.
- Agents push `claude/Q<n>-…` branches and open pull requests **in the sandbox**. Issues for this board
  live in the sandbox too. Actions are disabled there (agents run the suite in their own VM), so they can't
  spend the account's shared CI minutes.
- The owner **promotes** a reviewed branch into this repository by hand, opens the pull request here, and
  CI (`test`) and `agent-guard` (`guardrails/policy`) run on it. Merging and deploying stay manual.

| Control | Enforced by |
|---|---|
| Agents can't push to, merge in or change this repository | **They have no credentials for it**: the app is installed on the sandbox only (verified in the pilot) |
| Agents can't deploy or reach production | No Fly or SMTP credentials anywhere in the cloud environment, and its network allowlist excludes production and mail hosts (verified in the pilot) |
| Nothing reaches `main` here without passing the merge policy | Only the owner's account (and the grader) can push here. Merges follow "Merging" below: never with a red `test` or `guardrails/policy` |
| Promoted pull requests: material changes, attribution lines, secrets, real-looking emails, the freeze | `agent-guard`, run from the base branch, which must be `main`; re-checked at merge time by `scripts/agents/merge.sh`. **Advisory on Free**: it can't be made a required check, so nothing merges unless `test` and `guardrails/policy` are both green |
| Cloud-session command and file rules | `.claude/hooks/cloud-guard.mjs`: friction, not a boundary |
| **Not enforceable on Free** | Direct pushes to `main` here by anyone with write access (the owner, the grader, or a leaked token); a promoted PR that edits `.github/workflows/` forging `guardrails/policy` (always review `.github/` changes by hand). Agents in the sandbox can push to the sandbox's `main`, force-push or delete branches there; the owner resets the sandbox from this repository whenever needed. |

## Merging (risk-based)

The owner has given standing authorization for routine engineering: the local lead session (Claude Code on
the owner's machine) promotes reviewed sandbox work and merges pull requests here without a per-PR approval.
Production (deploying, secrets, restoring or changing production data) is outside this policy and needs the
owner's approval once per release.

**Classification** (`.github/agent-guard/classify.sh`, tested by `test/guard-policy.test.ts`). It is **default
deny**: a change is routine only if every file is on `routine-paths.txt`, none is on `critical-paths.txt`, and
no content rule fires.
- **Material** (needs the owner's review: the `owner-approved-paths` label, applied by the owner by hand
  after the last push):
  - any path on `critical-paths.txt`, or not on `routine-paths.txt`. That covers `lib/` (apart from a few
    presentation modules), every route handler and layout, server actions, scripts, configs, signing, auth,
    data, secrets, infrastructure, dependencies, and the checks themselves (this guard, CI, agent rules, test
    runners and helpers, scoring fixtures, the policy's own test);
  - in routine code: an added `"use server"`, any uppercase SQL keyword, or a new import of a data, auth or
    signing module;
  - any deletion in an existing test file, removing or renaming one, or any skip, fixme, fail, todo, skipIf or
    runIf, conditional or not;
  - a file whose diff GitHub doesn't show (other than binary fixtures, images and visual baselines).
- **Blocked**: focused tests (`.only` in any form; Playwright also has `forbidOnly` in CI), a PR not into
  `main`, a file list GitHub truncates, secrets, attribution lines, AI-authored commits, real-looking emails,
  and anything after the freeze without the owner's `freeze-exception`.
- **Routine**: pages and components that don't touch data, docs, static assets, new tests and added test
  lines, fixtures for new work, and reviewed visual baselines.

**How a pull request merges.** Only through `scripts/agents/merge.sh <n>`. At merge time it re-checks:
1. the PR is open into `main`, and its head is the exact commit that was reviewed;
2. `test` and `guardrails/policy` are green on that commit;
3. the freeze, read from the repository variable at that moment;
4. main's `classify.sh` on the PR as it is now (nothing blocks; anything material carries the owner's label);
5. a recorded `Independent review: PASS at <sha>` comment for that commit.

It then squash-merges pinned to that commit (`--match-head-commit`) and waits for CI on `main`. If `main`
goes red, nothing else merges until it is fixed.

**Freeze.** `AGENT_FREEZE_AT` is the real submission deadline minus 12 hours, in UTC, ending in `Z` or an
offset, and set only by the owner; it is never guessed. Unset means no freeze (the check notes it).
`guardrails/policy` is computed on pull request events, so a status from before the freeze can stay green
after it; `merge.sh` closes that gap for the lead session by reading the variable at merge time.

**Limits (GitHub Free).**
- There is no branch protection and no required check. `guardrails/policy` is advisory, so the rules above
  bind the lead session through `merge.sh` and the owner by discipline. A merge from the GitHub UI, or a
  direct push to `main`, bypasses everything here.
- The lead session uses the owner's own token, so GitHub can't tell its actions from the owner's. A label it
  applied would look exactly like the owner's approval. It never applies `owner-approved-paths` or
  `freeze-exception`; a separate collaborator account for the lead session would make that enforceable.
- The classification is a heuristic over the files GitHub lists and the lines a PR adds. It can't judge
  intent: logic changed in a routine file using imports it already had, or data access through existing
  helpers, is caught only by the independent review. That review is recorded on the PR but, being done with
  the same token, can't be proven independent by GitHub.
- A PR that edits `.github/workflows/` could post its own `guardrails/policy`. `.github/` is always material,
  and `merge.sh` re-runs the classification itself rather than trusting the status.

## Owner procedures (local, by hand)

Agent commits in the sandbox are authored by Claude, and their pull requests come from cloud sessions. That
history stays in the sandbox as the provenance record. **It is never copied into this repository**: each
reviewed sandbox pull request becomes one owner-authored squash commit here.

```bash
# promote sandbox PR #<n>: one commit on a new branch from main, authored by your own git identity, no
# co-author or "Generated" lines (the script refuses otherwise). It never pushes.
scripts/agents/promote.sh <n> claude/Q1-docs "docs: submission refresh"

# review the commit, then push and open the pull request here yourself
git push -u origin claude/Q1-docs && gh pr create -R parammadan/countersign --base main --head claude/Q1-docs

# record provenance in the sandbox (internal), e.g.:
gh api repos/parammadan/agreementos-agents/issues/<n>/comments -f body="Promoted as <sha> (countersign PR #<m>)"

# after every merge here: reset the sandbox's main to this repository's main
git fetch origin && git push --force agents origin/main:main
```

Merge promoted pull requests with **squash** only when `test` and `guardrails/policy` are green. The policy
check fails any commit authored by an AI identity, and any co-author, session or "Generated with/by" line in
commits or the description (the template's checklist lines are ignored).

**Freeze:** at `AGENT_FREEZE_AT`, uninstall or suspend the Claude GitHub App on the sandbox. That cuts
agents off completely; this repository was never reachable to them.
