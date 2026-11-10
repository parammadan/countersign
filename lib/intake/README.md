# M4 intake prototype

Deterministic document intake: extracted text pages in, an `IntakeRecord` out (document type with reasons, parties,
key dates, amounts, governing law, signature blocks, conflicts, missing fields, routing decision).

## Interface

```ts
import { analyzeDocument, intakeDocument } from "@/lib/intake/intake";
analyzeDocument({ pages: string[], metadata?: { filename?, title?, sourceId? } }): IntakeRecord          // sync, rules only
intakeDocument(input, { provider?: ModelProvider }): Promise<IntakeRecord>                               // optional model step
```

- Input is plain extracted text, one string per page. To feed it from a PDF, join each page's `TextItem.str`
  (from `lib/pdf/extract.ts`, read-only) per line; this module does not import `lib/**`.
- Every extracted value is `{ value, source: { page (1-based), quote } }`; the quote is a verbatim substring of that
  page, enforced by a final `verified` filter. Missing required fields are listed in `missing`, never guessed.
- Routing: `unsupported` (no text, type other, invoice), `needs_review` (conflicts, missing, ambiguity, injection,
  model-chosen type), `ready_to_prepare` (all required fields, no conflicts).
- Injection: lines that look like instructions to an AI are excluded from all extraction and from the model prompt,
  listed in `injection`, and force `needs_review`.
- The `ModelProvider` is only called when two candidate types tie; its answer is accepted only if it is one of the
  tied candidates, and it can never change extracted values. Tests use a stub; no real provider is wired.
- Dates are read month-first for `MM/DD/YYYY`. No OCR. No storage: nothing here touches a database.

## Shared types

`types.ts` re-exports `Clause`, `DraftDocument`, `EditProposal` and `ModelProvider` from `lib/m23/shared/agreement-model.ts`.

## In the app

`lib/intake/service.ts` runs this module for a session (upload or pasted text), stores the record per workspace
(`lib/intake/store.ts`, tables created at first use) and records an `intake.completed` workflow event. The optional
model step is not wired in the app: intake is rules only.

## Limits (best effort, by design)

- Injection quarantine is pattern based on a normalised copy (NFKC; zero-width, bidi, tag and other format
  characters removed; accents stripped; look-alike letters from Cyrillic, Greek, small capitals, IPA, stroked Latin,
  Armenian, Cherokee and Lisu mapped to Latin; letter-spaced words joined). Up to 8 consecutive lines (400 normalised
  characters; only the end of the first and the start of the last line count) are joined with a space, with nothing,
  or with a line-end hyphen removed, also with one or two short interjected lines (headers, footers up to 80 characters) left out; blank, invisible-only
  and page-number lines and page breaks are skipped, and 3+ one- or two-character lines are read as one word. A line
  with a disguised word is quarantined too (with a warning): any Lisu or Cherokee letter; a word with ASCII letters that
  also holds a letter from any non-Latin script, an IPA/small-capital look-alike or a non-ASCII digit; or an
  all-look-alike word of 4+ letters in an English line. Ordinary non-English
  Latin names (Søren, Łódź, Nguyễn), µm and Cyrillic text are not. Leetspeak, uniform letter-spacing of a whole
  instruction and novel phrasings are not caught. It can be bypassed by a novel phrasing; the backstop is that rules decide everything, the model may only pick among tied
  candidates, and a model-chosen type always routes to `needs_review`.
- The split-injection scan has a per-document work budget (60,000 joined windows). A document that exhausts it
  (huge and repetitive) gets a warning, routes to review and is never sent to the model.
- Lines are cut at 2000 characters and documents at 500 pages; either adds a `warnings` entry and forces review.
- `metadata` is returned as a fresh copy of the known keys only (`filename`, `title`, `sourceId`; unknown keys such
  as a workspace id are dropped). A known key that is not a short printable string, or a title/file name that reads
  like an instruction, is dropped with a warning. `metadata.title` is echoed only.
- Fail closed on money: two different figures under any label (including unlabelled, price and late fee) are a
  conflict; an amount with no recognised label, a scaled amount ("$5 million"), unusual digit grouping, another
  currency, currency after the number or money in words adds a warning. None of these is ever guessed.
- Amounts are read from the NFKC form of a line (fullwidth digits and symbols). With the read amounts blanked out, a
  labelled figure left on the line (not a "Schedule 2" reference, a period such as "30 days", a percentage or an
  ordinal), or a comma-grouped number on a line that talks about money, also adds a warning, as does a scale word
  within 20 characters after an amount ("$5–million", "$5 (five) million"). `rate`, `compensation` and `liability_cap` are labels.
- A notice, amendment or letter about an agreement adds a warning: it is not a new agreement to prepare. Checked in
  the first 6 non-empty lines (numbering removed, their first 100 characters), and up to line 12 (after a
  letterhead) in short ALL CAPS lines or lines that read as a notice title ("Termination Notice", "Notice of ...",
  "Amendment No. 2", "Deed of Variation"; clause headings such as "Notices" or "Termination" do not count) (notice, notification, withdrawal, end of engagement, amendment,
  modification, supplement, termination, renewal, letter...; "engagement letter" and "letter of engagement" are
  allowed) and body-wide only for wording a contract does not use ("hereby terminates", "hereby notified",
  "this Amendment", "this notice"). Leetspeak and novel phrasings are not caught.
- `MM/DD/YYYY` is read month-first; when both parts could be a month a warning is added and routing becomes needs_review.
- Provider calls time out after 10 s and fall back to the rules.
