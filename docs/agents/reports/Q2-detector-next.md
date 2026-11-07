# Q2: unseen agreement set and an honest detector score

Two measurements on the same 8 synthetic agreements (82 ground-truth fields). Read (b); (a) is kept because it was
the first run and the owner's review found a harness mismatch in it.

| | Run | firmName passed | P | R | TP | FP | FN | wrong role | wrong type | Client sig. right | Firm sig. right |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) | original, as run | none (harness mismatch) | 0.635 | 0.573 | 47 | 27 | 35 | 19 | 10 | 5 of 8 | 5 of 8 |
| (b) | **corrected, production-equivalent** | firm's legal name | **0.730** | **0.659** | 54 | 20 | 28 | 12 | 10 | **6 of 8** | **6 of 8** |

## Correction: what was wrong with (a)

`test/detect.test.ts` reads an optional `firmName` from each fixture's `.expected.json` and passes it to
`detectFields`, as production does (production always passes the workspace's legal entity name). Every earlier
fixture set sets it; the first version of this set did not, so run (a) exercised a path the product never uses (the
report shows `firm: -` for every document). This was not noticed before the original report was written.

Fix, in `scripts/make-next.mjs` only: each document's `.expected.json` now carries `firmName`, the legal name of the
firm that would own the workspace as it appears in that document. No field, box, type or role changed (checked by
comparing every regenerated `.expected.json` with the previous commit after removing `firmName`). Measurement (b) is
the one and only run after that change.

| # | firmName | Where it appears |
|---|---|---|
| 01 | Ledgerwick & Pole Chartered Accountants | letterhead (signature block says "Ledgerwick & Pole") |
| 02 | Fenworth Oakes Solicitors | printed only in capitals (heading and "FOR FENWORTH OAKES SOLICITORS"); written in normal case as a workspace name would be |
| 03 | Plinth Studio Architects | heading |
| 04 | Brassfinch Marketing Co. | firm signature-block heading |
| 05 | Harrowgate Wealth Partners | heading and preamble |
| 06 | Lintwhistle Translation Services | heading and caption under the firm's line |
| 07 | Crankshaw Networks Ltd | printed only in capitals ("CRANKSHAW NETWORKS LTD"); normal case as above |
| 08 | Owlcroft Tutoring | heading and "For Owlcroft Tutoring" |

The detector's "defined terms" line in (b) shows it matched each name (e.g. `firm=[crankshaw networks, crankshaw]`).

Same session, two unrelated fixes: the comment above doc 06 in the generator now names the captions actually drawn
("Client" / "For Lintwhistle Translation Services"), and the doc 01 letterhead postcode is now the obviously fake
"ZZ9 9ZZ". The postcode change alters the text of `01-…pdf` but no blank or field position.

## Per-document results

| # | Document | Fields | (a) P / R | (b) P / R | Change |
|---|---|---|---|---|---|
| 01 | Ledgerwick & Pole, accounting letter | 10 | 0.30 / 0.30 | **1.00 / 1.00** | all 7 swapped-party fields now right |
| 02 | Fenworth Oakes Solicitors | 8 | 0.88 / 0.88 | 0.88 / 0.88 | none |
| 03 | Plinth Studio Architects | 14 | 1.00 / 1.00 | 1.00 / 1.00 | none |
| 04 | Brassfinch Marketing | 13 | 0.00 / 0.00 | 0.00 / 0.00 | none |
| 05 | Harrowgate Wealth Partners | 11 | 0.91 / 0.91 | 0.91 / 0.91 | none |
| 06 | Lintwhistle Translation | 6 | 0.17 / 0.17 | 0.17 / 0.17 | none |
| 07 | Crankshaw Networks | 10 | 0.36 / 0.50 | 0.36 / 0.50 | same errors; firm-block confidences rose (0.55 to 0.80/0.85) |
| 08 | Owlcroft Tutoring | 10 | 0.70 / 0.70 | 0.70 / 0.70 | same errors; low-confidence warning gone |

Signature lines missed in (b): both parties' in doc 04 (ruled cells) and doc 06 (caption-only lines).

## How the set was made

- `node scripts/make-next.mjs` regenerates `fixtures/next/` (8 PDFs + 8 `.expected.json`). Output is byte-identical
  across runs (fixed dates and metadata); re-checked after the correction (two runs, same SHA-256 for all 16 files).
- Written without opening `lib/detect.ts`, `lib/pdf/`, the existing fixture sets or the source of
  `test/detect.test.ts` (for the correction session's limited look, see "Process notes"). Conventions come from the header comment of `scripts/make-final.mjs` (top-left origin;
  box bottom on the blank, underscore baseline + 2pt or the drawn rule; signature 24pt, initials 18pt, checkbox =
  square + 1pt each side, others 14pt) and the field types and roles in `lib/fields.ts`.
- Every page was rendered with its ground-truth boxes drawn on top and checked by eye before the run.
- All firms, people, emails and addresses are invented (`example.com`).

| # | Document | Layout it tests | Fields |
|---|---|---|---|
| 01 | Ledgerwick & Pole, accounting engagement letter | Letter, Times; stacked `Label: ____` blocks, **firm block first**, client block headed only by "I confirm that I have read…"; prefill blanks in the letter header | 10 |
| 02 | Fenworth Oakes Solicitors, client care letter | A4; two-column signature table of **drawn rules with captions under the lines** | 8 |
| 03 | Plinth Studio Architects, appointment | **Client initials in every page footer**; five option checkboxes | 14 |
| 04 | Brassfinch Marketing, SOW / order form | **Ruled table cells as blanks** (no underscores or rules inside cells): order grid at the top, signature grid at the end | 13 |
| 05 | Harrowgate Wealth Partners, advisory agreement | Consent checkboxes, email for notices, side-by-side **`By:` / `Its:`** corporate blocks | 11 |
| 06 | Lintwhistle Translation, services agreement | **Two signature lines on one text line**, party captions under them ("Client" / "For Lintwhistle…"), captioned date lines | 6 |
| 07 | Crankshaw Networks, managed IT services | Courier "plain text" contract; **dotted leaders** (`Name ........: ......`) instead of underscores | 10 |
| 08 | Owlcroft Tutoring, tuition agreement | One page; parent/guardian as the client; `Signed ____ Dated ____` on one line; contact-detail text fields | 10 |

Ground-truth role convention (my judgement; see "Debatable labels" below): blanks inside a party's signature block or
section are that party's; blanks in the header or order form that the firm fills from the file are `prefill`.

## Findings, from run (b) unless marked (reported, not fixed: the detector is out of scope)

1. **Withdrawn as a detector weakness: block-order party attribution (doc 01).** In run (a), with no firm name, all 7
   signature-block fields in doc 01 got the other party (firm block first, client block headed only by "I confirm
   that I have read…"). With the firm's name passed, as in production, doc 01 scores 1.00 / 1.00. What remains true
   is narrower: *without* a firm name the detector appears to fall back to client-then-firm order, so a caller that omits
   `firmName` gets swapped parties on firm-first documents. Production does not omit it.
2. **Ruled table cells aren't blanks to the detector (doc 04, 0.00 / 0.00, unchanged).** None of the 13 fields was
   found: not the order-form grid, not the signature grid. Both "no client signature" and "no firm signature"
   warnings fired on a document with two signature cells. This matches the known weak spot in `docs/SUBMISSION.md`
   (order-form grids), and here it also hides the signature.
3. **Signature lines identified only by a caption beneath them are typed as text (doc 06, 0.17, unchanged).** "Client"
   under the left line became `text/client`; "For Lintwhistle Translation Services" under the right line became
   `text/prefill` with a custom prefill key, even though the firm name was now known and recognised. Captioned "Date"
   lines became `date/prefill` (file.date) instead of each party's signing date. Doc 02's captions-under table, by
   contrast, worked: there the caption is "Signature".
4. **Dotted leaders confuse row association (doc 07, 0.36 / 0.50, unchanged).** The leader dots inside labels
   (`Name ........:`) were taken as 4 extra blanks, and the value lines in the signature blocks were labelled from
   the row *below* ("blank above 'Date'"), shifting name/title/date by one row; the last line in each block became an
   unlabelled `text/prefill` "Blank". The firm name raised confidence on the firm block but did not fix this.
5. Strong spots: all 8 checkboxes and both footer initials (doc 03: 1.00 / 1.00), `By:` / `Its:` blocks (doc 05),
   `Signed ____ Dated ____` on one line (doc 08), and, with the firm name, firm-first stacked blocks (doc 01).

### Debatable labels (ground-truth convention, not clearly detector errors)

The same 7 misses as in (a) remain in (b): contact fields the client fills (doc 08 phone, email, emergency contact;
doc 05 email for notices) labelled `prefill` by the detector; and header blanks ("Client: ____", "Customer ......:")
labelled `text/client` where I wrote `name/prefill` or `company/prefill` (docs 02, 06, 07). Counting all 7 as
correct would give **P 0.82 / R 0.74** for (b) (TP 61, FP 13, FN 21). The headline numbers are the unadjusted ones.
(The original report's adjusted figure for (a), roughly 0.73 / 0.66, equals the unadjusted (b) only by coincidence:
it came from 7 different fields.)

## Comparison with the final set

`docs/SUBMISSION.md` reports 0.89 / 0.85 for the first run of the final set, whose fixtures all pass `firmName`.
Run (b) uses the same harness path, so the method now matches; run (a) did not and should not be compared with it.
On that like-for-like basis this set scores lower: 0.73 / 0.66, a gap of 0.16 in precision and 0.19 in recall. Most
of the gap is concentrated in three documents (04, 06, 07: 23 of the 28 false negatives) whose layouts were chosen to
differ from common ones, without knowledge of what the detector was tuned on. Eight documents are a small sample,
and this set was deliberately built from varied layouts, so the gap shows weak spots on those layouts rather than a
general error rate for real agreements.

## Process notes, for honesty

- Before writing the set, to learn the `.expected.json` shape, I ran the test twice against a throwaway one-field
  probe PDF in my scratch directory (one `Client signature: ____` line). That showed the report format and that a
  plain underscore signature line is detected; nothing else about the detector.
- When reading the header comment of `scripts/make-final.mjs` I printed its first 60 lines, which also showed the
  imports, constants and the start of its layout class constructor (no detector logic, no fixture content).
  `make-next.mjs` has its own layout code.
- That probe did not reveal the `firmName` input, and the original set omitted it; see "Correction" above.
- In the correction session I grepped `test/` for `firmName` (the type of an expected file and the
  `detectFields(ex, { firmName: exp.firmName })` call) and listed the `firmName` values of the other fixture sets to
  confirm they all set it. I did not open `lib/detect.ts` or `lib/pdf/`.
- After run (a), no field, box, type or role was changed. After run (b), nothing in the fixtures was changed.

## Full output of run (b), corrected

`FIXTURE_DIR=fixtures/next npx vitest run test/detect.test.ts`

```

 RUN  v4.1.12 /home/user/agreementos-agents

stdout | test/detect.test.ts > field detector corpus > scores every fixture and prints a report

DETECTOR CORPUS  (match: same page+type+role, centre within 40pt x / 25pt y)
┌─────────┬────────────────────────────────────────────┬─────┬─────┬────┬────┬────┬────────────┬────────────┬────────┬────────┬──────────┐
│ (index) │ fixture                                    │ exp │ det │ TP │ FP │ FN │ wrong role │ wrong type │ P      │ R      │ warnings │
├─────────┼────────────────────────────────────────────┼─────┼─────┼────┼────┼────┼────────────┼────────────┼────────┼────────┼──────────┤
│ 0       │ '01-ledgerwick-accounting-letter'          │ 10  │ 10  │ 10 │ 0  │ 0  │ 0          │ 0          │ '1.00' │ '1.00' │ 'ok'     │
│ 1       │ '02-fenworth-solicitors-a4-captions-under' │ 8   │ 8   │ 7  │ 1  │ 1  │ 1          │ 1          │ '0.88' │ '0.88' │ 'ok'     │
│ 2       │ '03-plinth-architects-initials-checkboxes' │ 14  │ 14  │ 14 │ 0  │ 0  │ 0          │ 0          │ '1.00' │ '1.00' │ 'ok'     │
│ 3       │ '04-brassfinch-marketing-order-grid'       │ 13  │ 1   │ 0  │ 1  │ 13 │ 0          │ 1          │ '0.00' │ '0.00' │ 'ok'     │
│ 4       │ '05-harrowgate-advisory-consents-by-its'   │ 11  │ 11  │ 10 │ 1  │ 1  │ 1          │ 0          │ '0.91' │ '0.91' │ 'ok'     │
│ 5       │ '06-lintwhistle-translation-side-by-side'  │ 6   │ 6   │ 1  │ 5  │ 5  │ 4          │ 3          │ '0.17' │ '0.17' │ 'ok'     │
│ 6       │ '07-crankshaw-it-courier-dotted'           │ 10  │ 14  │ 5  │ 9  │ 5  │ 3          │ 5          │ '0.36' │ '0.50' │ 'ok'     │
│ 7       │ '08-owlcroft-tutoring-one-line'            │ 10  │ 10  │ 7  │ 3  │ 3  │ 3          │ 0          │ '0.70' │ '0.70' │ 'ok'     │
└─────────┴────────────────────────────────────────────┴─────┴─────┴────┴────┴────┴────────────┴────────────┴────────┴────────┴──────────┘
BY TYPE/ROLE (FP keyed by the detected type/role, FN by the expected one)
┌─────────┬────────────────────┬────┬────┬────┬────────┬────────┐
│ (index) │ type/role          │ TP │ FP │ FN │ P      │ R      │
├─────────┼────────────────────┼────┼────┼────┼────────┼────────┤
│ 0       │ 'checkbox/client'  │ 8  │ 0  │ 0  │ '1.00' │ '1.00' │
│ 1       │ 'company/prefill'  │ 0  │ 0  │ 2  │ '-'    │ '0.00' │
│ 2       │ 'date/client'      │ 5  │ 1  │ 3  │ '0.83' │ '0.63' │
│ 3       │ 'date/firm'        │ 5  │ 2  │ 3  │ '0.71' │ '0.63' │
│ 4       │ 'date/prefill'     │ 1  │ 2  │ 1  │ '0.33' │ '0.50' │
│ 5       │ 'email/client'     │ 0  │ 0  │ 2  │ '-'    │ '0.00' │
│ 6       │ 'email/prefill'    │ 0  │ 2  │ 1  │ '0.00' │ '0.00' │
│ 7       │ 'initials/client'  │ 2  │ 0  │ 0  │ '1.00' │ '1.00' │
│ 8       │ 'name/client'      │ 4  │ 1  │ 2  │ '0.80' │ '0.67' │
│ 9       │ 'name/firm'        │ 3  │ 1  │ 2  │ '0.75' │ '0.60' │
│ 10      │ 'name/prefill'     │ 3  │ 0  │ 3  │ '1.00' │ '0.50' │
│ 11      │ 'signature/client' │ 6  │ 0  │ 2  │ '1.00' │ '0.75' │
│ 12      │ 'signature/firm'   │ 6  │ 0  │ 2  │ '1.00' │ '0.75' │
│ 13      │ 'text/client'      │ 0  │ 5  │ 2  │ '0.00' │ '0.00' │
│ 14      │ 'text/prefill'     │ 8  │ 5  │ 1  │ '0.62' │ '0.89' │
│ 15      │ 'title/client'     │ 1  │ 1  │ 1  │ '0.50' │ '0.50' │
│ 16      │ 'title/firm'       │ 2  │ 0  │ 1  │ '1.00' │ '0.67' │
└─────────┴────────────────────┴────┴────┴────┴────────┴────────┘
OVERALL  TP=54 FP=20 FN=28  precision=0.730  recall=0.659  wrong-role=12 wrong-type=10  warnings ok 8/8

DETAILS (ROLE/TYPE = right box, wrong label; counted as 1 FP + 1 FN)
── 02-fenworth-solicitors-a4-captions-under  (firm: Fenworth Oakes Solicitors)
   TYPE+ROLE expected p0 name/prefill @(95,137 189x14)  got p0 text/client "Client" @(95,139 189x14) conf=0.85 [blank after "Client"; client fills it in]
   warnings: (none)
   defined terms: firm=[fenworth oakes solicitors, fenworth] client=[]

── 04-brassfinch-marketing-order-grid  (firm: Brassfinch Marketing Co.)
   FN        p0 company/prefill @(198,111 356x14)
   FN        p0 name/prefill @(198,133 356x14)
   FN        p0 email/prefill @(198,155 356x14)
   FN        p0 text/prefill @(198,177 356x14)
   FN        p0 date/prefill @(198,199 356x14)
   FN        p1 signature/firm @(380,76 164x24)
   FN        p1 name/client @(128,108 164x14)
   FN        p1 name/firm @(380,108 164x14)
   FN        p1 title/client @(128,130 164x14)
   FN        p1 title/firm @(380,130 164x14)
   FN        p1 date/client @(128,152 164x14)
   FN        p1 date/firm @(380,152 164x14)
   TYPE      expected p1 signature/client @(128,76 164x24)  got p1 text/client "Customer" @(124,58 172x13) conf=0.6 [form row "Customer" with a drawn line; client fills it in]
   warnings: "No client signature line was found." | "No signature line for your firm was found. Your acceptance will still be recorded on the certificate."
   defined terms: firm=[brassfinch marketing, brassfinch] client=[]

── 05-harrowgate-advisory-consents-by-its  (firm: Harrowgate Wealth Partners)
   ROLE      expected p0 email/client @(183,547 228x14)  got p0 email/prefill "Email address for notices" @(183,548 228x14) conf=0.85 [blank after "Email address for notices"; filled from file data (custom.email_address_for_notices)]
   warnings: (none)
   defined terms: firm=[harrowgate wealth partners, harrowgate, the adviser] client=[the client]

── 06-lintwhistle-translation-side-by-side  (firm: Lintwhistle Translation Services)
   ROLE      expected p0 date/client @(72,591 123x14)  got p0 date/prefill "Date" @(72,592 123x14) conf=0.8 [blank above "Date"; filled from file data (file.date)]
   ROLE      expected p0 date/firm @(342,591 123x14)  got p0 date/prefill "Date" @(342,592 123x14) conf=0.8 [blank above "Date"; filled from file data (file.date)]
   TYPE      expected p0 signature/client @(72,531 199x24)  got p0 text/client "Client" @(72,542 199x14) conf=0.8 [blank above "Client"; client fills it in]
   TYPE+ROLE expected p0 name/prefill @(104,129 199x14)  got p0 text/client "Client" @(104,130 199x14) conf=0.85 [blank after "Client"; client fills it in]
   TYPE+ROLE expected p0 signature/firm @(342,531 199x24)  got p0 text/prefill "For Lintwhistle Translation Services" @(342,542 199x14) conf=0.8 [blank above "For Lintwhistle Translation Services"; filled from file data (custom.for_lintwhistle_translation_services)]
   warnings: "No client signature line was found." | "No signature line for your firm was found. Your acceptance will still be recorded on the certificate."
   defined terms: firm=[lintwhistle translation services, lintwhistle] client=[]

── 07-crankshaw-it-courier-dotted  (firm: Crankshaw Networks Ltd)
   FP        p0 name/client "Name" @(89,619 46x13) conf=0.85 [blank after "Name"; under "SIGNED for and on behalf of the CUSTOMER"]
   FP        p0 date/client "Date" @(89,664 46x13) conf=0.85 [blank after "Date"; under "SIGNED for and on behalf of the CUSTOMER"]
   FP        p1 name/firm "Name" @(89,108 46x13) conf=0.85 [blank after "Name"; under "SIGNED for and on behalf of CRANKSHAW NETWORKS LTD"]
   FP        p1 date/firm "Date" @(89,130 46x13) conf=0.85 [blank after "Date"; under "SIGNED for and on behalf of CRANKSHAW NETWORKS LTD"]
   TYPE      expected p1 name/firm @(146,105 200x14)  got p1 date/firm "Date" @(146,108 200x13) conf=0.8 [blank above "Date"; under "SIGNED for and on behalf of CRANKSHAW NETWORKS LTD"]
   TYPE      expected p0 name/client @(146,616 200x14)  got p0 title/client "Job title" @(146,619 200x13) conf=0.8 [blank above "Job title"; under "SIGNED for and on behalf of the CUSTOMER"]
   TYPE+ROLE expected p0 company/prefill @(157,103 222x14)  got p0 text/client "Customer" @(157,106 222x13) conf=0.85 [blank after "Customer"; client fills it in]
   TYPE+ROLE expected p1 date/firm @(146,127 108x14)  got p1 text/prefill "Blank" @(146,130 108x13) conf=0.4 [unlabelled blank; filled from file data (custom.blank_14)]
   TYPE+ROLE expected p0 date/client @(146,661 108x14)  got p0 text/prefill "Blank" @(146,664 108x13) conf=0.4 [unlabelled blank; filled from file data (custom.blank_9)]
   warnings: "Some fields are low-confidence. Check the highlighted ones."
   defined terms: firm=[crankshaw networks, crankshaw] client=[]

── 08-owlcroft-tutoring-one-line  (firm: Owlcroft Tutoring)
   ROLE      expected p0 text/client @(166,293 150x14)  got p0 text/prefill "Parent/guardian phone" @(166,294 150x14) conf=0.85 [blank after "Parent/guardian phone"; filled from file data (custom.parent_guardian_phone)]
   ROLE      expected p0 email/client @(163,322 211x14)  got p0 email/prefill "Parent/guardian email" @(163,323 211x14) conf=0.85 [blank after "Parent/guardian email"; filled from file data (custom.parent_guardian_email)]
   ROLE      expected p0 text/client @(151,351 228x14)  got p0 text/prefill "Emergency contact" @(151,352 228x14) conf=0.85 [blank after "Emergency contact"; filled from file data (custom.emergency_contact)]
   warnings: (none)
   defined terms: firm=[owlcroft tutoring, owlcroft] client=[]

 ✓ test/detect.test.ts (1 test) 327ms
     ✓ scores every fixture and prints a report  326ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  06:00:10
   Duration  535ms (transform 89ms, setup 0ms, import 112ms, tests 327ms, environment 0ms)
```

## Full output of run (a), original as-run (no firmName)

```

 RUN  v4.1.12 /home/user/agreementos-agents

stdout | test/detect.test.ts > field detector corpus > scores every fixture and prints a report

DETECTOR CORPUS  (match: same page+type+role, centre within 40pt x / 25pt y)
┌─────────┬────────────────────────────────────────────┬─────┬─────┬────┬────┬────┬────────────┬────────────┬────────┬────────┬──────────┐
│ (index) │ fixture                                    │ exp │ det │ TP │ FP │ FN │ wrong role │ wrong type │ P      │ R      │ warnings │
├─────────┼────────────────────────────────────────────┼─────┼─────┼────┼────┼────┼────────────┼────────────┼────────┼────────┼──────────┤
│ 0       │ '01-ledgerwick-accounting-letter'          │ 10  │ 10  │ 3  │ 7  │ 7  │ 7          │ 0          │ '0.30' │ '0.30' │ 'ok'     │
│ 1       │ '02-fenworth-solicitors-a4-captions-under' │ 8   │ 8   │ 7  │ 1  │ 1  │ 1          │ 1          │ '0.88' │ '0.88' │ 'ok'     │
│ 2       │ '03-plinth-architects-initials-checkboxes' │ 14  │ 14  │ 14 │ 0  │ 0  │ 0          │ 0          │ '1.00' │ '1.00' │ 'ok'     │
│ 3       │ '04-brassfinch-marketing-order-grid'       │ 13  │ 1   │ 0  │ 1  │ 13 │ 0          │ 1          │ '0.00' │ '0.00' │ 'ok'     │
│ 4       │ '05-harrowgate-advisory-consents-by-its'   │ 11  │ 11  │ 10 │ 1  │ 1  │ 1          │ 0          │ '0.91' │ '0.91' │ 'ok'     │
│ 5       │ '06-lintwhistle-translation-side-by-side'  │ 6   │ 6   │ 1  │ 5  │ 5  │ 4          │ 3          │ '0.17' │ '0.17' │ 'ok'     │
│ 6       │ '07-crankshaw-it-courier-dotted'           │ 10  │ 14  │ 5  │ 9  │ 5  │ 3          │ 5          │ '0.36' │ '0.50' │ 'ok'     │
│ 7       │ '08-owlcroft-tutoring-one-line'            │ 10  │ 10  │ 7  │ 3  │ 3  │ 3          │ 0          │ '0.70' │ '0.70' │ 'ok'     │
└─────────┴────────────────────────────────────────────┴─────┴─────┴────┴────┴────┴────────────┴────────────┴────────┴────────┴──────────┘
BY TYPE/ROLE (FP keyed by the detected type/role, FN by the expected one)
┌─────────┬────────────────────┬────┬────┬────┬────────┬────────┐
│ (index) │ type/role          │ TP │ FP │ FN │ P      │ R      │
├─────────┼────────────────────┼────┼────┼────┼────────┼────────┤
│ 0       │ 'checkbox/client'  │ 8  │ 0  │ 0  │ '1.00' │ '1.00' │
│ 1       │ 'company/prefill'  │ 0  │ 0  │ 2  │ '-'    │ '0.00' │
│ 2       │ 'date/client'      │ 4  │ 2  │ 4  │ '0.67' │ '0.50' │
│ 3       │ 'date/firm'        │ 4  │ 3  │ 4  │ '0.57' │ '0.50' │
│ 4       │ 'date/prefill'     │ 1  │ 2  │ 1  │ '0.33' │ '0.50' │
│ 5       │ 'email/client'     │ 0  │ 0  │ 2  │ '-'    │ '0.00' │
│ 6       │ 'email/prefill'    │ 0  │ 2  │ 1  │ '0.00' │ '0.00' │
│ 7       │ 'initials/client'  │ 2  │ 0  │ 0  │ '1.00' │ '1.00' │
│ 8       │ 'name/client'      │ 3  │ 2  │ 3  │ '0.60' │ '0.50' │
│ 9       │ 'name/firm'        │ 2  │ 2  │ 3  │ '0.50' │ '0.40' │
│ 10      │ 'name/prefill'     │ 3  │ 0  │ 3  │ '1.00' │ '0.50' │
│ 11      │ 'signature/client' │ 5  │ 1  │ 3  │ '0.83' │ '0.63' │
│ 12      │ 'signature/firm'   │ 5  │ 1  │ 3  │ '0.83' │ '0.63' │
│ 13      │ 'text/client'      │ 0  │ 5  │ 2  │ '0.00' │ '0.00' │
│ 14      │ 'text/prefill'     │ 8  │ 5  │ 1  │ '0.62' │ '0.89' │
│ 15      │ 'title/client'     │ 1  │ 2  │ 1  │ '0.33' │ '0.50' │
│ 16      │ 'title/firm'       │ 1  │ 0  │ 2  │ '1.00' │ '0.33' │
└─────────┴────────────────────┴────┴────┴────┴────────┴────────┘
OVERALL  TP=47 FP=27 FN=35  precision=0.635  recall=0.573  wrong-role=19 wrong-type=10  warnings ok 8/8

DETAILS (ROLE/TYPE = right box, wrong label; counted as 1 FP + 1 FN)
── 01-ledgerwick-accounting-letter  (firm: -)
   ROLE      expected p1 signature/client @(120,303 198x24)  got p1 signature/firm "Signature" @(120,302 198x26) conf=0.35 [blank after "Signature"; party not named near this block: please check]
   ROLE      expected p1 signature/firm @(120,144 198x24)  got p1 signature/client "Signature" @(120,143 198x26) conf=0.35 [blank after "Signature"; party not named near this block: please check]
   ROLE      expected p1 name/firm @(104,185 198x14)  got p1 name/client "Name" @(104,185 198x15) conf=0.35 [blank after "Name"; party not named near this block: please check]
   ROLE      expected p1 title/firm @(114,215 198x14)  got p1 title/client "Position" @(114,216 198x15) conf=0.35 [blank after "Position"; party not named near this block: please check]
   ROLE      expected p1 date/firm @(99,246 138x14)  got p1 date/client "Date" @(99,246 138x15) conf=0.35 [blank after "Date"; party not named near this block: please check]
   ROLE      expected p1 name/client @(126,343 198x14)  got p1 name/firm "Print name" @(126,344 198x15) conf=0.35 [blank after "Print name"; party not named near this block: please check]
   ROLE      expected p1 date/client @(99,374 138x14)  got p1 date/firm "Date" @(99,374 138x15) conf=0.35 [blank after "Date"; party not named near this block: please check]
   warnings: "Some fields are low-confidence. Check the highlighted ones."
   defined terms: firm=[] client=[]

── 02-fenworth-solicitors-a4-captions-under  (firm: -)
   TYPE+ROLE expected p0 name/prefill @(95,137 189x14)  got p0 text/client "Client" @(95,139 189x14) conf=0.85 [blank after "Client"; client fills it in]
   warnings: (none)
   defined terms: firm=[] client=[]

── 04-brassfinch-marketing-order-grid  (firm: -)
   FN        p0 company/prefill @(198,111 356x14)
   FN        p0 name/prefill @(198,133 356x14)
   FN        p0 email/prefill @(198,155 356x14)
   FN        p0 text/prefill @(198,177 356x14)
   FN        p0 date/prefill @(198,199 356x14)
   FN        p1 signature/firm @(380,76 164x24)
   FN        p1 name/client @(128,108 164x14)
   FN        p1 name/firm @(380,108 164x14)
   FN        p1 title/client @(128,130 164x14)
   FN        p1 title/firm @(380,130 164x14)
   FN        p1 date/client @(128,152 164x14)
   FN        p1 date/firm @(380,152 164x14)
   TYPE      expected p1 signature/client @(128,76 164x24)  got p1 text/client "Customer" @(124,58 172x13) conf=0.6 [form row "Customer" with a drawn line; client fills it in]
   warnings: "No client signature line was found." | "No signature line for your firm was found. Your acceptance will still be recorded on the certificate."
   defined terms: firm=[] client=[]

── 05-harrowgate-advisory-consents-by-its  (firm: -)
   ROLE      expected p0 email/client @(183,547 228x14)  got p0 email/prefill "Email address for notices" @(183,548 228x14) conf=0.85 [blank after "Email address for notices"; filled from file data (custom.email_address_for_notices)]
   warnings: (none)
   defined terms: firm=[] client=[the client]

── 06-lintwhistle-translation-side-by-side  (firm: -)
   ROLE      expected p0 date/client @(72,591 123x14)  got p0 date/prefill "Date" @(72,592 123x14) conf=0.8 [blank above "Date"; filled from file data (file.date)]
   ROLE      expected p0 date/firm @(342,591 123x14)  got p0 date/prefill "Date" @(342,592 123x14) conf=0.8 [blank above "Date"; filled from file data (file.date)]
   TYPE      expected p0 signature/client @(72,531 199x24)  got p0 text/client "Client" @(72,542 199x14) conf=0.8 [blank above "Client"; client fills it in]
   TYPE+ROLE expected p0 name/prefill @(104,129 199x14)  got p0 text/client "Client" @(104,130 199x14) conf=0.85 [blank after "Client"; client fills it in]
   TYPE+ROLE expected p0 signature/firm @(342,531 199x24)  got p0 text/prefill "For Lintwhistle Translation Services" @(342,542 199x14) conf=0.8 [blank above "For Lintwhistle Translation Services"; filled from file data (custom.for_lintwhistle_translation_services)]
   warnings: "No client signature line was found." | "No signature line for your firm was found. Your acceptance will still be recorded on the certificate."
   defined terms: firm=[] client=[]

── 07-crankshaw-it-courier-dotted  (firm: -)
   FP        p0 name/client "Name" @(89,619 46x13) conf=0.85 [blank after "Name"; under "SIGNED for and on behalf of the CUSTOMER"]
   FP        p0 date/client "Date" @(89,664 46x13) conf=0.85 [blank after "Date"; under "SIGNED for and on behalf of the CUSTOMER"]
   FP        p1 name/firm "Name" @(89,108 46x13) conf=0.55 [blank after "Name"; the other block belongs to the client]
   FP        p1 date/firm "Date" @(89,130 46x13) conf=0.55 [blank after "Date"; the other block belongs to the client]
   TYPE      expected p1 name/firm @(146,105 200x14)  got p1 date/firm "Date" @(146,108 200x13) conf=0.55 [blank above "Date"; the other block belongs to the client]
   TYPE      expected p0 name/client @(146,616 200x14)  got p0 title/client "Job title" @(146,619 200x13) conf=0.8 [blank above "Job title"; under "SIGNED for and on behalf of the CUSTOMER"]
   TYPE+ROLE expected p0 company/prefill @(157,103 222x14)  got p0 text/client "Customer" @(157,106 222x13) conf=0.85 [blank after "Customer"; client fills it in]
   TYPE+ROLE expected p1 date/firm @(146,127 108x14)  got p1 text/prefill "Blank" @(146,130 108x13) conf=0.4 [unlabelled blank; filled from file data (custom.blank_14)]
   TYPE+ROLE expected p0 date/client @(146,661 108x14)  got p0 text/prefill "Blank" @(146,664 108x13) conf=0.4 [unlabelled blank; filled from file data (custom.blank_9)]
   warnings: "Some fields are low-confidence. Check the highlighted ones."
   defined terms: firm=[] client=[]

── 08-owlcroft-tutoring-one-line  (firm: -)
   ROLE      expected p0 text/client @(166,293 150x14)  got p0 text/prefill "Parent/guardian phone" @(166,294 150x14) conf=0.85 [blank after "Parent/guardian phone"; filled from file data (custom.parent_guardian_phone)]
   ROLE      expected p0 email/client @(163,322 211x14)  got p0 email/prefill "Parent/guardian email" @(163,323 211x14) conf=0.85 [blank after "Parent/guardian email"; filled from file data (custom.parent_guardian_email)]
   ROLE      expected p0 text/client @(151,351 228x14)  got p0 text/prefill "Emergency contact" @(151,352 228x14) conf=0.85 [blank after "Emergency contact"; filled from file data (custom.emergency_contact)]
   warnings: "Some fields are low-confidence. Check the highlighted ones."
   defined terms: firm=[] client=[]

 ✓ test/detect.test.ts (1 test) 361ms
     ✓ scores every fixture and prints a report  359ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  04:55:46
   Duration  659ms (transform 136ms, setup 0ms, import 166ms, tests 361ms, environment 0ms)
```

## Other tests

Correction session (after the fixture change):

- `npx tsc --noEmit`: clean.
- `npm run lint`: 0 errors, 4 warnings, all in files this task doesn't touch (`components/SigningRoom.tsx`,
  `e2e/screens.spec.ts`, `scripts/make-final.mjs`, `scripts/make-holdout.mjs`).
- `npx vitest run`: 11 files, 47 tests passed.
- `npm run build` and Playwright were not re-run in this session; only fixtures, the generator script and this report
  changed. Original session: build succeeded; `PW_CHANNEL=chromium npx playwright test` 27 passed, 4 skipped
  (visual), using the environment's pre-installed Chromium because `npx playwright install chromium` was blocked by
  the network policy.
