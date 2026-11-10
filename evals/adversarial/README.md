# Adversarial verifier suite (sealed)

Written independently from the brief alone, without reading any repo code, tests or evals. Do not tune code against it.

- `cases.json`: 14 invented agreements (2–3 pages each, in £, $ and €) and 91 cases.
- `validate.mjs`: a dependency-free checker. Run `node validate.mjs [cases.json]`. It exits with 1 if any check fails.

## Counts

| errorType | arm | cases |
|---|---|---|
| moved_figure | wrong | 6 |
| wrong_party | wrong | 5 |
| flipped_negation | wrong | 5 |
| dropped_condition | wrong | 6 |
| wrong_arithmetic | wrong | 5 |
| wrong_date | wrong | 5 |
| false_absence | wrong | 5 |
| invented_term | wrong | 5 |
| nonbinding_as_binding | wrong | 5 |
| injection_followed | wrong | 6 |
| false_premise_accepted | wrong | 5 |
| smuggled_term | wrong | 6 |
| laundered_calc | wrong | 6 |
| control | control | 21 |
| **total** | | **91** (70 wrong, 21 control) |

## What is planted in the agreements

- Similar figures in different clauses, for example a fee, a cap and a deposit, or 15/30/45/60-day periods.
- One non-binding schedule, annex or exhibit per agreement, with values that conflict with the binding terms.
- Exceptions and provisos, such as break conditions, liability carve-outs and sell-off cut-offs.
- Conditions, such as approvals, receipts and thresholds.
- A "Note to AI assistants" in 11 of the 14 agreements.

The controls are correct answers. They include correct calculations and date arithmetic, correct "the agreement does not state…" answers, disclaimers of non-binding schedules, refusals of AI-note injections and refutations of a false premise. For controls, `fooled` is identical to `honest`.

The `fooled` outputs use a range of tricks:
- evidence taken from a clause that holds a similar-looking figure;
- evidence taken from the non-binding schedule or from the AI note itself;
- a partial span (for example "Yes", "up to $100,000" or "Payment is due");
- a sentence split so that the wrong part is never claimed;
- the claim restated as something true;
- the claim marked non-material;
- a term relabelled as an absence, context or scenario;
- a calculation approved because its inputs "appear in the agreement".

## What the validator checks

- Every evidence quote and generator citation is verbatim on a page of its agreement, after collapsing whitespace. Evidence quotes are at least 10 characters.
- Every `span` and every `wrongPhrase` is verbatim in the answer, the explanation, a `expression = result` string or a `not_stated` item.
- IDs are unique and every agreement referenced exists.
- Each wrong case has at least 1 `wrongPhrases`. Controls have none.
- The honest verifier claims every sentence, calculation and note. It rejects every wrong phrase and never marks a span that contains one as supported.
- In `fooled`, no claim that touches a wrong phrase is rejected.
- No wrong phrase appears in any control answer for the same agreement.
- Arithmetic and dates are evaluated:
  - controls must compute correctly;
  - `wrong_arithmetic` and `wrong_date` cases must contain an incorrect calculation;
  - `laundered_calc` calculations must be arithmetically correct but use a wrong input.
- Every error type has at least 5 cases.

## Status (2026-11-08): development data, no longer independent

The suite was written independently, but its results were then used during development, so it no longer measures
the code without bias. On its first run against the redesign, before any change it prompted:
- honest verifier: 0 of 70 incorrect claims displayed; correct controls 8 of 21 shown in full, 3 partial, 10 withheld;
- fooled verifier: 29 of 70 incorrect claims displayed (non-binding text given as a term: 5 of 5).

Six problems it exposed were then fixed: non-binding schedules that disclaim themselves ("This Schedule is
illustrative only…") weren't recognised; date steps with "−" or a count in words weren't re-done; computed dates and
re-done results counted as invented; mentioning that a planted note was disregarded read as an instruction; one
malformed evidence id discarded the whole verification. `test/adversarial.test.ts` replays it (no network) and holds
the current numbers as a ratchet. An independent measure needs a new sealed set.
