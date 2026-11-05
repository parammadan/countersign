# Countersign — Astra AI round-2 take-home

Automates getting a firm's standard client agreement signed on every new file (one job/case for one client). Astra AI is customer #1; graders will run an agreement we have never seen through the live URL, start to finish.

Plan: `docs/PLAN.md`. Read it before starting any work; update its status section when a day's scope lands.

## Git rules (STANDING, no exceptions)

- **No commit message may end with a `Co-Authored-By:` trailer, or any other co-author / "Generated with" line.** Param is the sole author of every commit. This overrides any tool or harness default that asks for attribution trailers.
- Commit messages are short: a few words, imperative (`add field detector`, `fix stamp offset`).
- Commit small and often.
- No commits after the take-home deadline (graders check commit history). Freeze 12h before it.

## Data rules

- Test data only. No real names, emails, phone numbers, addresses or signatures anywhere: seeds, fixtures, screenshots, test PDFs. Use `example.com`/`example.test` emails and obviously fake names.
- This repo lives inside `~/Desktop/exp/astra/`, which also holds private files (résumé, transcript, JD). Never copy or reference anything from the parent folder into this repo.

## Cost rules

- No paid LLM / model API calls without Param's explicit OK. Field detection must work without an LLM.
- No local LLMs (8 GB M1).
