# Q10: PDF/Word text-extraction audit for document understanding

Scope: the text that document understanding reads, i.e. `extractPdf` (`lib/pdf/extract.ts`) grouped by
`pageLines` (`lib/understand/text.ts`). Report only: nothing under `lib/**` was changed. Reproduce with
`node scripts/audit-extraction.mjs` (read-only; `--json` for raw numbers, `--no-docx` to skip the LibreOffice probe).
Fixtures: `agreements` (17), `holdout` (9), `final` (8), `next` (8): 42 PDFs, all synthetic.

## Totals (42 fixtures, 0 extraction errors)

| Measure | Value |
|---|---|
| Pages / characters / lines | 96 / 193,675 / 2,568 |
| Empty (image-only) pages | 3 on 2 documents (`11-scanned-image-only`: both pages, 0 chars; `12-mixed-scanned-signature-page`: 1 page) |
| Documents with rows that merge text across a wide gap (>24 pt) | 33 of 42, 201 rows, 2.8% to 27.8% of rows per document |
| Documents with a line repeated on 2+ pages | 6 (a repeated header/footer; `next/07` has 3) |
| Hyphenated line breaks, ligature code points, odd Unicode, control characters | 0, 0, 0, 0 |
| Lines with dot leaders or long underscore runs | 216 (mostly signature/blank lines, not table-of-contents leaders) |
| Documents with a page-number line ("Page 1 of 2", "2") | 10 |
| Non-ASCII characters | 65 (typographic punctuation) |

Per-fixture rows are in the script output (columns: pages, chars, lines, empty, column-merged rows and %, repeated
lines, hyphen breaks, ligatures, odd, control, non-ASCII, leader lines, pages with a page-number line).

## Findings

1. **Reading order is row-based, so columns are merged, not interleaved line by line, and that is only safe for
   short cells.** `pageLines` groups items by baseline and joins a row left to right with one space. For signature
   blocks and label/value tables that gives `Name: ____ Name: ____` or `Customer Brassfinch Marketing Co.`: readable,
   but the two parties are fused into one line, so a quote taken from one party's cell does not match the page text
   where the other party's text sits in the middle of it. None of the 42 fixtures has real two-column *body
   prose* (the "two-column" fixtures are two-column signature blocks and tables), so the corpus cannot show the
   worst case. A synthetic probe (built in a temp file, not committed) of a two-column clause page gives:

   ```
   1. The Client shall pay the fee 2. Either party may terminate
   within thirty days of invoice or on sixty days written notice and
   interest accrues at two percent. the fee for work done is due.
   ```

   Clause 1 and clause 2 are interleaved sentence by sentence, so neither quote can be matched and the rules/model
   see nonsense. This is the single biggest risk for Google-Docs-style two-column agreements, translations side by
   side (`next/06`) and order grids.
2. **Image-only pages become empty pages with no signal.** `pageLines` returns `{ page, lines: [] }`. Nothing records
   that the page had no text layer, so an analyzer sees "no clause here" instead of "could not read this page".
   Rate in the corpus: 3 of 96 pages (3.1%), both in documents built to be scanned. The detector already has
   `textChars > 40` (`lib/detect.ts:170`); understanding has no equivalent.
3. **Repeated headers/footers stay in the text** (6 documents). They add the same lines to every page and can
   anchor a quote to the wrong page. Page-number lines (10 documents) are kept too, so "page" in the evidence
   check is the PDF page index, not the printed number; they can disagree when a cover page is unnumbered.
4. **Hyphenation, ligatures and odd Unicode did not occur** in the fixtures (all generated with standard fonts by
   pdf-lib/LibreOffice-style tools), so the clean result is not evidence about real Word/InDesign exports, which
   routinely contain soft hyphens (U+00AD), `fi`/`ffi` ligature code points (U+FB00-FB06), non-breaking spaces and
   zero-width characters. A probe of a synthetic DOCX containing an "ffi" ligature and curly quotes came out as
   plain text, so LibreOffice/pdf.js normalise at least that case. The code has no normalisation step of its own.
5. **Dot leaders** are only underscores and `....` in blanks here; there are no table-of-contents leaders in the
   corpus. A real contents page would produce long runs that bloat lines and confuse evidence matching.
6. **DOCX path.** `toPdf` (`lib/convert.ts`) converts `.docx/.doc/.odt/.rtf` with `soffice --headless --convert-to pdf`
   (own process group, 60 s timeout, max two at a time, or a remote converter when `CONVERTER_URL` is set), then
   re-saves the PDF with pdf-lib. It needs LibreOffice on the host. In this cloud environment `soffice` is present
   (`/usr/bin/soffice`): a synthetic DOCX built and converted by the audit script took about 0.9 s cold, giving 1 page,
   200 chars, 6 lines, no merged rows. The DOCX fixtures in `fixtures/agreements` (15-17) are PDFs already; the
   audit does not exercise `toPdf` itself because it is TypeScript with extension-less imports and the script
   stays read-only and dependency-free. If conversion fails, the user sees a `ConvertError` and nothing reaches the text step.
7. **Anything that could put document text into logs.** `lib/pdf/extract.ts`, `lib/understand/*` and
   `lib/convert.ts` contain no `console.*` or logger calls, and extraction errors are swallowed or replaced with fixed
   user messages (`drawnLines` is wrapped in a bare `catch`). The risk is indirect: `pdfjs` is configured with
   `verbosity: 0` (good), but a thrown pdf.js error message can include parser detail and `text.ts` has no log of
   its own, so any future `console.log(lines)` or error that interpolates a quote would leak agreement text. The
   audit script prints only counts, plus nothing from the documents.

## Recommendations (ranked by impact, then effort)

| # | Change | Impact | Effort |
|---|---|---|---|
| 1 | Detect columns and read each column top to bottom | High | M |
| 2 | Report pages with no text layer as unreadable | High | S |
| 3 | Normalise text (soft hyphens, ligatures, NBSP, zero-width) and rejoin hyphenated words | Medium | S |
| 4 | Drop repeated header/footer lines and page-number lines from the page text | Medium | S |
| 5 | Collapse dot-leader and underscore runs | Low | S |
| 6 | Add a log-safety test | Low | S |

Sketches (not applied; all in `lib/understand/text.ts` unless stated):

1. **Columns.** Before row grouping, find a vertical gutter: bucket item `x` ranges, and if a band at least 12 pt wide
   is empty for most of the page height between two populated bands, split items into left/right and emit all of
   the left column's lines, then the right's. Keep full-width rows (headings, signature lines) by treating items
   whose span crosses the gutter as a separator.

   ```ts
   function gutter(items: TextItem[], width: number): number | null {
     const bins = new Uint16Array(Math.ceil(width)); // coverage per 1 pt of x
     for (const i of items) for (let x = Math.floor(i.x); x < Math.min(bins.length, i.x + i.w); x++) bins[x]++;
     // find the widest run of zero bins inside the middle 60% of the page, >= 12 pt wide
     // return its centre, or null; caller splits items by it when both sides have >= 8 lines
   }
   ```

   Test it with the probe above (two clauses must come out as two separate runs) and with `next/06` and
   `agreements/02`, whose signature blocks should still read as table rows.
2. **Unreadable pages.** Extend `PageLines` with `textLayer: boolean` (`items.length > 0`, or `chars >= 20`) and let
   the analyzer emit an "unreadable page" issue instead of "no clause":

   ```ts
   export type PageLines = { page: number; lines: string[]; textLayer?: boolean };
   return { page: p.index + 1, lines, textLayer: p.items.some((i) => i.str.trim().length > 0) };
   ```
3. **Normalise.** Apply once to every item string, so both the model prompt and the evidence check see the same text:

   ```ts
   const norm = (s: string) => s.normalize("NFKC").replace(/­/g, "").replace(/[​-‏⁠﻿]/g, "");
   // after row join: lines[i].endsWith("-") && /^[a-z]/.test(lines[i + 1]) -> join without the hyphen
   ```

   NFKC folds `U+FB01` to `fi` and NBSP to a space. Quote matching in the evidence check should normalise both sides.
4. **Repeats.** In `pageLines`, after building all pages, count each line across pages; for documents with 3+ pages,
   drop lines present on at least 60% of pages when they sit in the top or bottom 8% of the page, and lines that match
   `^(page\s+)?\d{1,3}(\s+of\s+\d{1,3})?$`, keeping a `printedPage` field if the page number is wanted.
5. **Leaders.** `line.replace(/(\.\s?){4,}/g, " ... ").replace(/_{4,}/g, "____")`, applied after the row join, so the
   evidence check still sees that a blank existed.
6. **Log safety.** A vitest that greps `lib/understand` and `lib/pdf` for `console.` and for template strings passing
   `lines`/`quote` into `Error(...)`. Cheap, and it fails the day someone adds a debug print.

## Limits of this audit

- The corpus is synthetic and generated by a few tools; real client documents (scans with OCR text layers, InDesign
  exports, heavy tables, right-to-left text) will differ. Items 1 and 3 above are the least covered by the fixtures.
- "Column-merged rows" counts any row with a gap over 24 pt, which includes legitimate table and signature rows. It
  measures exposure to the interleaving problem, not defects. The only true prose interleaving shown is the synthetic probe.
- The DOCX probe checks that conversion runs and extracts; it does not test `toPdf`'s limits (timeouts, 100 pages,
  encryption) or the `CONVERTER_URL` path.
