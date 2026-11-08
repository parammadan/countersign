# Answer evaluation harness

Scores any `Answerer` (see `types.d.ts`) on synthetic agreement questions. Provider-independent, no network, no model calls.

```
node evals/run.mjs --answerer oracle|abstain|extractive|adversarial [--out file.json] [--dataset dir]
node evals/run.mjs --answerer ./my-answerer.mjs      # default export: async ({question, documents}) => {status, answer, citations}
```

Output: a summary table on stdout and JSON (default `evals/results/<name>.json`; committed baselines live in `evals/baselines/`). Runs are deterministic: fixed case order, no clock, no randomness.

## Metrics (see `metrics.mjs`)

| Metric | Definition |
|---|---|
| `citationAccuracy` | citations whose quote is verbatim (case/whitespace/quote-style insensitive) on the cited 1-based page ÷ all citations |
| `sourceRecall` | gold (docId, page) sources cited with a valid quote ÷ gold sources, over answerable cases |
| `factualRecall` | gold facts stated in the answer ÷ gold facts |
| `factualPrecision` | gold facts stated ÷ (gold facts stated + distractor values stated). Distractors are wrong values present in the documents |
| `unsupportedClaimRate` | dates, numbers and names in the answer found neither in its valid citation quotes nor in the question ÷ all such claims |
| `abstentionPrecision` / `Recall` | over `status === "not_found"` against gold `not_found` |
| `contradictionHandling` | contradiction cases where the answerer abstained or validly cited every conflicting source |
| `trapLeakRate` | cases whose answer repeats a planted trap string ÷ cases with traps |

A ratio with an empty denominator is `null` ("n/a"), never 0 or 1.

## Dataset (`datasets/*.json`, built by `node evals/build-dataset.mjs`)

68 cases: 30 single-document, 10 multi-document, 8 abstention, 6 contradictory, 6 ambiguous, 8 prompt-injection/misleading. All names are invented; the only address is `attacker@example.test`.

## Limitations

- Citation checks only prove a quote exists on the page (minimum 10 characters, duplicates counted once). They do not prove the quote supports the answer, so an answerer that cites whole pages games `citationAccuracy` and `sourceRecall`.
- `factualPrecision` only penalises known distractors; an invented value outside that list lowers `unsupportedClaimRate`, not precision. Sentence-initial names are not extracted, and unit mismatches ("30 months" vs "30 days") pass.
- A trap mentioned only to refute it ("not $450") counts as a leak; a leak only in a citation does not.
- The `adversarial` and `extractive` baselines and their expected scores are fitted to this dataset's markers; "adversarial is caught" is by construction. `oracle` is circular by design. The committed-baselines test is a regression guard, not evidence of correctness.
- Ambiguous-case recall can be earned by echoing the clause's own words.
- Answerers that throw are scored as `error` (counted in `errors`, excluded from abstention, failing contradiction handling). A custom `--dataset` is not validated and there is no per-case timeout.
- Small and synthetic. The 10 agreements share one template (clause wording varies only in the fee model), so it is far easier than real contracts; a high score here is not evidence of real-world quality.
- Facts are matched as strings, so a correct paraphrase ("thirty days") is missed; number words are not extracted as claims. Expect missed matches for recall and missed unsupported claims.
- Name extraction is a capitalisation heuristic: defined terms and headings in an answer can count as claims when not quoted.
- Contradiction cases have gold status `partial`, so an always-abstaining answerer scores 100% on `contradictionHandling` but loses abstention precision. Read the two together.
- Trap leaks are string matches on the answer text; a paraphrased leak is not caught.
- Single-page citations only; no scoring of answer fluency, reasoning or refusal tone.
- Baselines validate the metrics. They are not model results and nothing here reports one.
