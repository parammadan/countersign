## Task

Closes #<!-- issue number -->. Lane: <!-- the lane:* label from docs/agents/TASKS.md, or local-controlled -->

<!-- What changed and why, in two or three sentences. No "Generated with" line. -->

## Files owned by this PR

<!-- Every path this PR changes. It must match the "Owns" list in the task issue. Anything outside it,
or anything on .github/agent-guard/protected-paths.txt, needs the owner's `owner-approved-paths` label. -->

-

## Tests run (paste the summary lines)

- [ ] `npx tsc --noEmit`
- [ ] `npm run lint` (0 errors)
- [ ] `npx vitest run`
- [ ] `npm run build`
- [ ] `PW_CHANNEL=chromium npx playwright test` (not run in this environment? say why)
- [ ] Visual regression: not run by agents (baselines are macOS-only). UI changes: the reviewer regenerates and reviews baselines locally before merge.

## Risks and what I didn't do

<!-- What could break, what's untested, any follow-up needed. Say "none" only if that's true. -->

-

## Confirmations

- [ ] Based on the latest `main`; one task only; no unrelated edits
- [ ] Synthetic test data only (example.com / .test / .invalid); no real names, emails or documents
- [ ] No secrets, tokens, `.env` files, databases or production data added or read
- [ ] No production commands (Fly, deploy scripts, production URLs), no direct push to `main`, no merge
- [ ] No changes to signing, sealing, certificates, the audit trail, email delivery, auth, rate limits or the database schema
- [ ] No co-author, "Generated with" or session-link lines in commits or this description

---

### Reviewer checklist (repository owner)

- [ ] `test` and `guardrails/policy` are green on the latest commit
- [ ] The diff stays inside the files owned by the task issue; protected-path changes were reviewed line by line before applying `owner-approved-paths`
- [ ] No weakened tests: no skipped, deleted or loosened assertions without a stated reason
- [ ] No new dependencies, network calls, environment variables or external services without a decision
- [ ] UI changes: pulled locally, visual baselines regenerated on macOS and reviewed, phone and tablet checked
- [ ] Squash-merged by the owner; deploy only through the local controlled path with production verification
