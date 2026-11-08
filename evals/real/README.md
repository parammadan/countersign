# Real-model evaluation (paid)

Runs AgreementOS's Q&A against the real Anthropic API and scores it with the Q13 harness. It is not part of the
normal test suite or CI. Each run needs the owner's budget approval.

```
RUN_REAL_AI=1 REAL_SUITE=smoke|dev|holdout|security \
AI_LEDGER=/path/outside/repo/ledger.json AI_TEST_BUDGET_USD=20 REAL_OUT=/path/outside/repo/results \
ANTHROPIC_API_KEY=... npx vitest run -c vitest.real.config.mts
```

- The key is read from the environment only; it is never printed, written or logged (the SDK runs with logging off).
- `AI_LEDGER` keeps the total spent across runs. Before each call the worst case for that call (the whole input
  written to the cache and every output token used) is reserved, and the run stops before the total could pass
  `AI_TEST_BUDGET_USD` (at most $20). After each call the real cost, from the API's usage, is recorded.
- `holdout` reads `HOLDOUT_FILE` (a sealed set, kept outside the repo) and refuses to run a second time.
- Results (per case: status, the model's raw output, what was shown, cost, latency) go to `REAL_OUT`.
