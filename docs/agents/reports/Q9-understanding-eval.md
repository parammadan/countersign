# Q9: document-understanding evaluation set and harness

The first honest measurement of M2.1 document understanding (`lib/understand`, rules analyzer + evidence check).
Scores are reported, not gated: the harness asserts only invariants. A low score here is a finding, not something this
task fixed (`lib/understand/**` is out of scope and was not touched or, while writing cases, read: `rules.ts` was
not opened before the cases and ground truth were written).

## What was added

| Path | What |
|---|---|
| `fixtures/understanding/*.json` | 17 synthetic agreements with ground truth (`pages`, `title`, `fields`, `expect`, `traps`), plus 5 generated PDFs |
| `scripts/make-understanding.mjs` | `node scripts/make-understanding.mjs` regenerates the PDFs with pdf-lib (deterministic: fixed dates, rerun gives identical bytes) |
| `test/understand-eval.test.ts` | the harness: pluggable `Analyzer`, scoring, printed table, invariants |

Cases cover all seven categories and every hard case in the issue: conflicting start dates (02), blanks (03), no payment
(04), percentage fee (05), fees only in a schedule (06), three parties (07), commas and Inc./Ltd. (08), defined terms
before names (09), "3rd March 2026" and 03/04/2026 (10), amounts in words (11), buried auto-renewal (12), termination
without notice (13), prompt injection in a clause (14), in a footer (15) and disguised as an obligation (16), and a
two-column page (17). PDFs: 01, 02, 06, 14, 17.

## How it scores

- **Found (recall):** an `expect` entry is found if a finding in the same category carries its `value` (compared with
  case, spacing and punctuation ignored, in the finding's value or its evidence quote). Entries with no `value` match on
  `label` (a keyword in the finding's label, note or value) or, with neither, on category + status.
- **Status ok / status accuracy:** the matched finding has the expected status (stated / inferred / missing / ambiguous).
  Accuracy is status ok over found.
- **Page accuracy:** where the entry names a page and the finding has evidence, one quote is on that page.
- **Trap violation:** a finding with status `stated` whose label or value contains a trap value (an injected claim, or a
  fact the document never states).
- **Signatures:** the rules analyzer reads these from detected fields, so each case carries `fields` (ground truth
  standing in for `detectFields`, 0-based `page` as in `lib/detect`). That makes the signatures column a test of the
  analyzer's wording and pages, not of the field detector.
- Text cases run on `linesFromText(pages)`. PDF cases also run through `extractPdf` → `pageLines` with `documentTitle`.
- The default analyzer is `analyzeWithRules` + `groundFindings`. To measure another one (a model provider, later) with the
  same cases: `UNDERSTAND_ANALYZER=./path/module.ts npx vitest run test/understand-eval.test.ts`, where the module
  default-exports `(input: { pages, title, fields }) => Finding[]`.

## Invariants asserted (all pass)

1. At least 14 cases, every category covered, at least 4 PDF runs.
2. Every output finding parses with `FindingSchema`.
3. No trap value is ever reported as `stated` (0 violations across 22 runs).
4. Every `stated` finding outside "signatures" has evidence, and each quote is on the page it names.

## Full harness output (one run)

```
== TEXT input: 17 cases ==
category     expect  found recall status ok status acc  page acc
parties          35     32    91%        32       100%      100%
type             18     17    94%        17       100%      100%
dates            29     21    72%        19        90%      100%
payment          27     26    96%        26       100%       96%
obligations      12      9    75%         9       100%      100%
signatures       17     17   100%        17       100%      100%
gaps              5      1    20%         1       100%      100%
ALL             143    123    86%       121        98%       99%
trap violations (a trap value reported as stated): 0

case                       expect  found status ok  traps findings
01-engagement-basic            13     10        10      0 14
02-conflicting-dates            9      8         7      0 13
03-blanks                       7      7         7      0 13
04-no-payment                   9      8         8      0 12
05-percentage-fee               7      7         7      0 12
06-fees-in-schedule            10     10        10      0 12
07-three-parties                9      7         7      0 12
08-commas-and-suffixes          6      6         6      0 12
09-definitions-first            7      5         5      0 11
10-date-formats                 7      6         5      0 11
11-amounts-in-words             7      6         6      0 13
12-buried-auto-renewal         10      8         8      0 13
13-termination-no-notice        8      7         7      0 12
14-injection-clause             7      6         6      0 13
15-injection-footer             8      7         7      0 12
16-injection-obligation         8      7         7      0 12
17-two-column                  11      8         8      0 17

== PDF input: 5 cases ==
category     expect  found recall status ok status acc  page acc
parties          10      9    90%         9       100%      100%
type              6      5    83%         5       100%      100%
dates            10      8    80%         7        88%      100%
payment          12     12   100%        12       100%       92%
obligations       4      3    75%         3       100%      100%
signatures        5      5   100%         5       100%      100%
gaps              3      0     0%         0          -         -
ALL              50     42    84%        41        98%       98%
trap violations (a trap value reported as stated): 0

case                       expect  found status ok  traps findings
01-engagement-basic            13     10        10      0 14
02-conflicting-dates            9      8         7      0 13
06-fees-in-schedule            10     10        10      0 12
14-injection-clause             7      6         6      0 13
17-two-column                  11      8         8      0 19


misses (31):
- 01-engagement-basic [text] dates/stated 12 months -> not reported | p1 line 6: 2. Term. This letter remains in effect for 12 months and then ends unless the parties agree in writing to extend it.
- 01-engagement-basic [text] obligations/stated Ohio -> not reported | p2 line 1: 4. Governing law. This letter is governed by the laws of the State of Ohio.
- 01-engagement-basic [text] gaps/missing termination -> not reported
- 01-engagement-basic [pdf] dates/stated 12 months -> not reported | p1 line 6: 2. Term. This letter remains in effect for 12 months and then ends unless the parties agree in writing to extend it.
- 01-engagement-basic [pdf] obligations/stated Ohio -> not reported | p2 line 1: 4. Governing law. This letter is governed by the laws of the State of Ohio.
- 01-engagement-basic [pdf] gaps/missing termination -> not reported
- 02-conflicting-dates [text] dates/ambiguous date -> status stated, expected ambiguous
- 02-conflicting-dates [text] gaps/ambiguous start -> not reported
- 02-conflicting-dates [pdf] dates/ambiguous date -> status stated, expected ambiguous
- 02-conflicting-dates [pdf] gaps/ambiguous start -> not reported
- 04-no-payment [text] dates/stated 5 years -> not reported | p1 line 4: These obligations last for 5 years from the date above.
- 07-three-parties [text] dates/stated June 30, 2026 -> not reported | p1 line 4: The Escrow Agent will release the funds to the Seller on closing, which is scheduled for June 30, 2026.
- 07-three-parties [text] obligations/stated release the funds -> not reported | p1 line 4: The Escrow Agent will release the funds to the Seller on closing, which is scheduled for June 30, 2026.
- 09-definitions-first [text] parties/stated Westbrook Example LLC -> not reported | p1 line 3: 2. Parties. This Agreement is made on August 12, 2026 between Westbrook Example LLC (the Provider) and Ivy Sample Ltd (the Client).
- 09-definitions-first [text] parties/stated Ivy Sample Ltd -> not reported | p1 line 3: 2. Parties. This Agreement is made on August 12, 2026 between Westbrook Example LLC (the Provider) and Ivy Sample Ltd (the Client).
- 10-date-formats [text] dates/stated 3rd March 2026 -> not reported | p1 line 3: It takes effect on 3rd March 2026.
- 10-date-formats [text] dates/ambiguous date -> status missing, expected ambiguous
- 11-amounts-in-words [text] payment/stated two thousand five hundred -> not reported | p1 line 4: The Client shall also pay a deposit of two thousand five hundred dollars, refundable if the work does not start.
- 12-buried-auto-renewal [text] dates/stated automatically extended -> not reported | p3 line 3: 12. Renewal. Notwithstanding clause 2, on expiry of the initial term this Agreement is automatically extended for successive terms of 12 months each unless a party gives written notice of non-renewal at least 60 days before the end of the then-current term.
- 12-buried-auto-renewal [text] dates/stated 60 days -> not reported | p3 line 3: 12. Renewal. Notwithstanding clause 2, on expiry of the initial term this Agreement is automatically extended for successive terms of 12 months each unless a party gives written notice of non-renewal at least 60 days before the end of the then-current term.
- 13-termination-no-notice [text] dates/missing notice -> not reported
- 14-injection-clause [text] gaps/ambiguous assistant -> not reported
- 14-injection-clause [pdf] gaps/ambiguous assistant -> not reported
- 15-injection-footer [text] obligations/stated 99% uptime -> not reported | p2 line 2: The Host shall maintain 99% uptime.
- 16-injection-obligation [text] gaps/ambiguous reviewer -> not reported
- 17-two-column [text] parties/stated Juniper Example Ltd -> not reported | p1 line 2: Between Juniper Example Ltd
- 17-two-column [text] type/stated payroll -> not reported | p1 line 7: payroll processing services.
- 17-two-column [text] dates/stated April 20, 2026 -> not reported | p1 line 5: April 20, 2026.
- 17-two-column [pdf] parties/stated Juniper Example Ltd -> not reported | p1 line 2: Between Juniper Example Ltd
- 17-two-column [pdf] type/stated payroll -> not reported | p1 line 7: payroll processing services.
- 17-two-column [pdf] dates/stated April 20, 2026 -> not reported | p1 line 5: April 20, 2026.
```

## The 5 most important misses

1. **Buried auto-renewal not found** (12-buried-auto-renewal, p3 line 3: "…this Agreement is automatically extended for
   successive terms of 12 months each unless a party gives written notice of non-renewal at least 60 days before…").
   Neither the renewal nor its 60-day notice window is reported. This is the clause a client most needs surfaced.
2. **Conflicting start dates reported as settled** (02-conflicting-dates, text and PDF; p1 lines 2–3: "effective as of
   January 5, 2026" vs "The Provider will start the Services on March 1, 2026"). The dates output has no `ambiguous`
   finding; the date is reported as `stated`. The existing unit test passes with different wording ("Services commence
   on"), so detection depends on the verb.
3. **Date formats** (10-date-formats, p1 lines 3–4: "It takes effect on 3rd March 2026." / "The Services end on
   03/04/2026."). "takes effect on" and the ordinal date are not recognised (the date finding comes back `missing`), and
   the US/UK-ambiguous numeric date is never flagged as unclear. Neither wrongly reported reading appeared as `stated`
   (traps held).
4. **Defined terms before names** (09-definitions-first, p1 line 3: "between Westbrook Example LLC (the Provider) and Ivy
   Sample Ltd (the Client)"). Neither party is found when the roles are given without quotation marks, and the earlier
   definitions clause does not help.
5. **Two-column page and wrapped lines** (17-two-column, p1 lines 2–5, 7). In text form the party and the effective date
   are split across lines ("Between Juniper Example Ltd" / "…Sorrel Sample" / "Inc."), and in the PDF the columns
   interleave row by row; the party, agreement type and effective date are missed in both, plus "21 days" in the PDF.

Other patterns worth a look, lower priority: payment/term findings inside a clause that follows a section heading
("2. Term. … remains in effect for 12 months", 01 p1 line 6) are missed; governing law "State of Ohio" (01 p2 line 1) is
missed although "Delaware" and "Texas" are found; and the **gaps** category scores 1 of 5 on text and 0 of 3 on PDF, but
read that cautiously: cases expect hidden-instruction text and absent termination terms under `gaps`, while the analyzer
may file such findings under another category (the unit test shows "Text addressed to an automated reader" as
`ambiguous`; no `gaps`-category finding matched here). Whether those placements are right is a product decision for the
owner.

## Caveats

- 17 cases / 143 expectations is a small set, written by one author, so differences of a few points are noise.
- Ground truth is what a careful reader would report; where a judgement call exists (the `gaps` category, which findings
  count as "obligations"), the choice is recorded in each case's `expect`.
- This is the first run, written before looking at the analyzer's code. Anything tuned against these cases later is no
  longer an unseen measurement; write a new set for that.

## Commands

```
node scripts/make-understanding.mjs           # regenerate the 5 PDFs
npx vitest run test/understand-eval.test.ts   # run the harness (prints the table above)
```

Checks run on this branch: `npx tsc --noEmit` clean; `npm run lint` 0 errors (4 existing warnings in other files);
`npx vitest run` 20 files / 294 tests passed; `npm run build` succeeded. Playwright was not run (docs, fixtures and a test
file only; no UI change).
