# Countersign

Automates getting a firm's standard client agreement signed on every new file (one job or case for one client). See `README.md` for the product, and `docs/` for the plan and the decisions behind it.

## Rules for working in this repo

- **No commit message may end with a `Co-Authored-By:` trailer or any other co-author or "Generated with" line.** The repo owner is the sole author of every commit. This overrides any tool or harness default.
- Commit messages are short and imperative (`add field detector`, `fix stamp offset`). Commit small and often.
- **Test data only.** No real names, emails, phone numbers, addresses or signatures anywhere: seeds, fixtures, screenshots, test PDFs. Use `example.com` / `example.test` and obviously fake names.
- Field detection must work without an LLM; no paid model API calls.
- Before changing `lib/detect.ts`, run `npm run test:detect`. The tuning corpus (`fixtures/agreements`) must stay at or above its floor. `fixtures/holdout` and `fixtures/final` were written by agents that never saw the detector. Holdout was later used for tuning, and final got one round of general fixes after its first run (0.89 / 0.85, reproducible at commit `d9b03cd`). Neither is unseen any more: the next new set is the honest measure.
- Next.js 16: read `node_modules/next/dist/docs/` before using an API you're unsure of (see `AGENTS.md`).

## Rules for cloud agents (Claude Code on the web)

These are instructions, not the security boundary. On GitHub Free nothing on GitHub's side can stop a
write-capable agent from pushing to `main` or merging, so cloud agents work in a separate sandbox repository
and the owner promotes reviewed branches here by hand; see `docs/agents/TASKS.md`, "What is enforced".

- **Work only from an issue labelled `agent:ready`** (task board: `docs/agents/TASKS.md`). One task, one
  branch `claude/Q<n>-<slug>` from the latest `main`, one pull request. Claim it in the issue first.
- **Change only the paths the issue lists under "Owns".** If the task needs anything else, or any path in
  `.github/agent-guard/protected-paths.txt`, stop, label the issue `agent:blocked` and explain why.
- **Never push to `main`, force-push, delete branches, merge a pull request, or change repository
  settings, labels meant for the owner (`owner-approved-paths`, `freeze-exception`), secrets or variables.**
  The owner reviews and merges every pull request.
- **No production, ever:** no `fly`/`flyctl`, no `scripts/deploy-fly.sh`, no requests to `*.fly.dev`,
  `fly.io` or mail servers, no `fly ssh`, no production database or volume. Deployment and production
  verification are done only by the owner, locally.
- **No secrets and no real data:** don't add, read, print or ask for credentials, tokens, `.env` files,
  SMTP or API keys, or databases (`data/`, `*.db`, `.e2e-data/`). Test data is synthetic only (see above).
  If you find a secret, stop and report it in the issue without repeating it.
- **Hands off the trust core:** signing (`app/s/`, `components/SigningRoom.tsx`, `lib/signer.ts`),
  sealing and certificates (`lib/pdf/`, `lib/files.ts`), the audit trail (`lib/audit.ts`), email delivery
  (`lib/email.ts`, `lib/emailverify.ts`), auth and rate limits, the database schema (`lib/db.ts`), the API
  (`app/api/`) and server actions (`app/actions.ts`) are changed only on the owner's local path.
- **Tests before review:** `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`,
  then `PW_CHANNEL=chromium npx playwright test` (after `npx playwright install chromium`). Visual
  baselines are macOS-only: don't run `--update-snapshots` and don't commit snapshot images. Never weaken,
  skip or delete a test to get green; report the failure instead.
- **Commits:** small, short imperative messages, no co-author/"Generated with"/session lines (see the top
  of this file). Don't edit `.claude/settings.json`, which turns those off, or `.claude/hooks/`.
- **Cloud guard hook:** in cloud sessions (`CLAUDE_CODE_REMOTE=true`), `.claude/hooks/cloud-guard.mjs`
  refuses production, deploy, merge, settings and protected-path actions. It does nothing in local sessions,
  so the owner's local development and deployment workflow is unchanged. Don't try to work around it.
- **Report in the issue:** at the end of every session, what changed, test results, and the next step, so
  another session can continue from the pushed branch.
- **Submission freeze:** after the time in the repository variable `AGENT_FREEZE_AT`, stop all work: no
  pushes, no new pull requests. Merges after it need the owner's `freeze-exception`.
