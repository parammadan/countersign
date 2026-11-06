# Countersign

Automates getting a firm's standard client agreement signed on every new file (one job or case for one client). See `README.md` for the product, and `docs/` for the plan and the decisions behind it.

## Rules for working in this repo

- **No commit message may end with a `Co-Authored-By:` trailer or any other co-author or "Generated with" line.** The repo owner is the sole author of every commit. This overrides any tool or harness default.
- Commit messages are short and imperative (`add field detector`, `fix stamp offset`). Commit small and often.
- **Test data only.** No real names, emails, phone numbers, addresses or signatures anywhere: seeds, fixtures, screenshots, test PDFs. Use `example.com` / `example.test` and obviously fake names.
- Field detection must work without an LLM; no paid model API calls.
- Before changing `lib/detect.ts`, run `npm run test:detect`. The tuning corpus (`fixtures/agreements`) must stay at or above its floor. `fixtures/holdout` and `fixtures/final` were written by agents that never saw the detector. Holdout was later used for tuning, and final got one round of general fixes after its first run (0.89 / 0.85, reproducible at commit `d9b03cd`). Neither is unseen any more: the next new set is the honest measure.
- Next.js 16: read `node_modules/next/dist/docs/` before using an API you're unsure of (see `AGENTS.md`).
