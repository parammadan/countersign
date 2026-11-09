# AgreementOS

**Your client agreement, signed on every file, automatically.**

A firm uploads the agreement it already uses (PDF or Word) once. From then on, every new file (one job or case for one client) sends that agreement to the client, chases it, countersigns it for the firm and files the sealed copy. Nobody at the firm has to touch it.

- **Live:** https://countersign-app.fly.dev
- **What was built and why:** [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
- **Original plan and status:** [`docs/PLAN.md`](docs/PLAN.md)

## Try it in 3 minutes

1. **Create a workspace** at `/signup`. Enter your firm's legal name exactly as it appears in your agreement; that's how your signature block is told apart from the client's.
2. **Agreements → upload** your agreement (or click *Try a sample one*). AgreementOS reads it and marks every place someone signs, initials, dates or fills a blank: blue for the client, violet for your firm, amber for blanks filled from each file. Fix anything that's off (drag, resize, retype), then **Publish**.
3. **Settings → Firm countersignature**: type or draw it once.
4. **New file**: client name and email. The agreement is filled in and sent right away.
5. Open the signing link (from the email, **Copy signing link** on the file, or **Send a test to me** on the agreement) as the client: consent, review, sign, done. Your countersignature is applied immediately, and both sides get the sealed PDF with a certificate of completion.
6. Check any copy at `/verify`.

This whole path is the browser test `e2e/grader-path.spec.ts` (and `e2e/signing-mobile.spec.ts` on a phone-sized screen).

## What's in the product

### The firm's workspace

The first milestone (M1) of the redesign rebuilt the firm side on a shared design system. Everything below is on `main`.

| Feature | What you see | Code | Tests |
|---|---|---|---|
| Design system | One accent colour (each firm can set its own), neutral greys, status colours that always come with an icon or text, and shared buttons, cards, badges, notices, empty states and icons | `app/globals.css` (tokens), `components/ui.tsx`, `components/icons.tsx` | `e2e/a11y.spec.ts` (axe, WCAG 2.1 A + AA), `e2e/visual.spec.ts` (opt-in, see below) |
| App shell and navigation | A sidebar with the workspace, the signed-in user and their role. Only finished modules appear, and staff don't see admin-only pages | `lib/nav.ts` (`visibleNav`), `components/Nav.tsx`, `app/app/layout.tsx` | `e2e/overview.spec.ts` (staff don't see admin links), `e2e/a11y.spec.ts`, `e2e/security.spec.ts` (staff permissions) |
| Overview (`/app`) | What needs attention (email failed, waiting on a countersignature, signed copy not delivered, declined, expired, unsigned for 3+ days), file counts, one recommended next step and recent activity | `app/app/page.tsx`, `lib/dashboard.ts` | `test/dashboard.test.ts`, `e2e/overview.spec.ts` |
| Agreement library (`/app/agreements`) | All / Live / Draft / Archived views, search, version history, archive and restore, drag-and-drop upload with real progress | `app/app/agreements/page.tsx`, `lib/library.ts`, `components/UploadAgreement.tsx` | `test/library.test.ts`, `e2e/agreements.spec.ts` |
| Field editor (`/app/agreements/[id]`) | Detected fields over the pages, with a toolbar (undo, zoom), a field list, keyboard moves, fields kept inside the page, warnings when fields overlap, and a confirmation before publishing | `components/FieldEditor.tsx`, `components/PdfPages.tsx`, `lib/fields.ts` | `e2e/agreements.spec.ts`, `test/library.test.ts` |
| Client files (`/app/files`) | Cards on a phone and a table on a desktop | `app/app/files/page.tsx`, `components/FileTable.tsx` | `e2e/overview.spec.ts` (no sideways scrolling on a phone or tablet), `e2e/a11y.spec.ts`, `e2e/console.spec.ts`. The switch between cards and table isn't tested |
| Client file page (`/app/files/[id]`) | A stage tracker, the reminder plan, what happens next, and the "ready for work" checks. Re-sending the signed copy sends the same sealed PDF, and a repeat click within a minute isn't sent twice | `app/app/files/[id]/page.tsx`, `lib/filepage.ts`, `components/FileActions.tsx` | `test/filepage.test.ts`, `test/copyresend.test.ts`, `e2e/file-workspace.spec.ts`, `e2e/mail-flow.spec.ts`, `e2e/responsive.spec.ts` |

### Getting agreements signed

| Feature | Code | Tests |
|---|---|---|
| Upload a PDF or Word file (up to 20 MB). Word goes through LibreOffice, in a separate converter process in the Docker image | `lib/convert.ts`, `lib/templates.ts`, `scripts/converter.mjs`, `scripts/docker-start.sh` | `e2e/agreements.spec.ts` (upload checks); Word end to end only with the Docker command under [Run locally](#run-locally) |
| Field detection without an LLM, each field with a confidence and a reason; a signature page is added when there's no client signature line; scanned pages are flagged | `lib/detect.ts`, `lib/pdf/extract.ts`, `lib/templates.ts` | `test/detect.test.ts`, `test/flow.test.ts` |
| *Try a sample one* and *Send a test to me* | `app/api/agreements/sample/route.ts`, `app/actions.ts` | `e2e/grader-path.spec.ts` |
| Publishing needs a client signature; published versions can't be edited, and each file keeps the version it was sent with | `lib/fields.ts` (`validateForPublish`), `lib/templates.ts` | `test/flow.test.ts`, `e2e/agreements.spec.ts` (versions). The client-signature gate has no automated test |
| New files from the app, CSV import, the REST API or an inbound webhook URL; CSV export | `components/NewFileForm.tsx`, `app/actions.ts`, `app/api/v1/files/route.ts`, `app/api/inbound/[token]/route.ts`, `app/api/files/export/route.ts`, `lib/csv.ts` | `test/flow.test.ts` (`createFile`, which every route calls), `e2e/grader-path.spec.ts` (from the app), `test/csv.test.ts` (parsing only), `e2e/security.spec.ts` (API and inbound requests are refused without a valid key or token). A successful API or inbound create has no automated test |
| Prefill from file data (client name, email, company, file reference, date, firm name, custom blanks) | `lib/files.ts` (`prefillValues`) | None: tests fill blanks in, but no test checks the values that land in the PDF |
| Signing room: consent to electronic records, a "next field" guide, draw or type a signature, decline with a reason, optional emailed one-time code (off by default, and only available when email is configured) | `app/s/[token]/page.tsx`, `components/SigningRoom.tsx`, `components/SignaturePad.tsx`, `lib/consent.ts`, `lib/signer.ts` | `e2e/grader-path.spec.ts`, `e2e/signing-mobile.spec.ts`, `test/automation.test.ts` |
| Automatic countersignature (on by default; when it's off, the file page shows a *Countersign and complete* button) | `lib/files.ts` (`countersign`) | `test/flow.test.ts`, `test/automation.test.ts` |
| Reminders on days 2 and 5 and expiry after 14 days (both configurable per workspace) | `lib/worker.ts`, `lib/db.ts` (defaults) | `test/automation.test.ts` |
| Certificate of completion, SHA-256 of the original, client-signed and final PDFs, an append-only audit log, and `/verify` | `lib/pdf/stamp.ts`, `lib/files.ts`, `lib/audit.ts`, `lib/db.ts` (triggers), `app/verify/page.tsx`, `app/api/verify/route.ts` | `test/flow.test.ts`, `test/stamp.test.ts`, `e2e/grader-path.spec.ts` (a tampered copy fails) |
| Signed outbound webhooks with retries; SSRF checks when connecting | `lib/webhooks.ts`, `lib/ssrf.ts` | `test/automation.test.ts`, `test/ssrf.test.ts`, `e2e/webhook.spec.ts` |
| Email through SMTP or Resend, or kept in the in-app Email log when neither is set; failures are recorded on the file | `lib/email.ts`, `app/app/outbox/page.tsx` | `test/delivery.test.ts`, `e2e/mail-flow.spec.ts` |
| Workspaces, team invites with admin and staff roles, sign-in, CSRF/origin checks, rate limits | `lib/auth.ts`, `lib/http.ts`, `lib/ratelimit.ts`, `app/actions.ts` | `e2e/security.spec.ts` (sign-in, roles, CSRF, isolation). Rate limits and the daily file cap have no automated test |

## How it works

```
upload (PDF/DOCX) ──► LibreOffice (DOCX→PDF) ──► pdf.js: text + coordinates + drawn lines
                                                        │
                                   deterministic field detector (lib/detect.ts)
                                                        │
                 admin reviews in the field editor ──► publish an immutable version
                                                        │
new file (UI · CSV · REST API · inbound webhook · n8n) ─┤
                                                        ▼
          branded email ─► client signing room (consent → fill → sign) ─► pdf-lib stamps client fields
                                                        │
             auto-countersign with the firm's adopted signature ─► certificate of completion appended
                                                        │
          SHA-256 sealed · emailed to both sides · webhook file.completed · /verify can check any copy
```

- **Field detection without an LLM** (`lib/detect.ts`). It reads signature blocks (`By: ____`, `Signature: ____`, drawn rules with captions under them, `X ____`, dot leaders, signature tables, checkboxes, initials footers). It then works out which party each block belongs to, using defined terms in the preamble such as `("Client")`, headings above each column, the firm's legal name, and roles such as "Owner" or "Provider". Finally it maps body blanks ("Effective Date", "Fee: $____", `and ____ ("Client")`) to file data. Each proposal carries a confidence and a plain-English reason, shown in the editor.
- **Accuracy, measured on fake documents** (`test/detect.test.ts`, run by `npm run test:detect`):

  | corpus | docs | who wrote it | precision | recall |
  |---|---|---|---|---|
  | `fixtures/agreements` (tuning) | 17 (incl. 3 DOCX) | written alongside the detector | 0.99 | 0.96 |
  | `fixtures/holdout` | 9 | written without seeing the detector; then used for tuning | 0.95 | 0.89 |
  | `fixtures/final`, **first run** | 8 | written without seeing the detector: 4 AI/software-consulting agreements in Google Docs / Word layouts + 4 other services agreements | **0.89** | **0.85** |
  | `fixtures/final`, today | 8 | same; one round of general fixes since the first run | 0.97 | 0.91 |

  The first run on `final` is the best estimate for an agreement the detector has never seen. In that run the client signature line was found in 8 of 8 documents. Neither `holdout` nor `final` is unseen any more, so the next new set is the honest measure. Whatever the detector misses, the admin fixes in the editor, and publishing is blocked until there is a client signature.

  To reproduce the first run, start from a clean working tree. The detector is from commit `d9b03cd`, and the final set was added after it.

  ```bash
  git checkout d9b03cd && git checkout origin/main -- fixtures/final
  FIXTURE_DIR=fixtures/final npx vitest run test/detect.test.ts   # OVERALL precision=0.888 recall=0.853
  git reset -q --hard && git checkout -   # back to where you were
  ```
- **Ready for work, earned.** A completed file is shown as ready only after the app re-checks five things: consent, the client's signature, the firm's countersignature, that the sealed PDF on disk still matches its recorded SHA-256, and that the file hasn't been voided. The check is `readiness` in `lib/files.ts`. It shows on the file page and in `GET /api/v1/files/:id` (`test/flow.test.ts`, `test/filepage.test.ts`; `e2e/security.spec.ts` for the API).
- **Honest delivery.** Every client email's result is recorded on the file and in the audit trail: sent, failed with the provider's error, or logged when no provider is configured. With real email on, a new workspace must confirm its owner's address before it can email anyone outside its team (`lib/emailverify.ts`, `test/delivery.test.ts`).
- **Legal trail.** An ESIGN-style consumer disclosure with logged consent (`lib/consent.ts`), explicit intent to sign, and an optional emailed one-time code. An append-only audit log (`lib/audit.ts`; SQLite triggers in `lib/db.ts` reject UPDATE and DELETE) records IP, user agent and timestamps. SHA-256 hashes cover the original, client-signed and final PDFs, and the certificate of completion is appended to the final PDF.

## Stack

Next.js 16 (App Router, server actions, route handlers) · React 19 · TypeScript · Tailwind 4 · SQLite via Node's built-in `node:sqlite` (WAL) · pdf.js (extraction + in-browser rendering) · pdf-lib (stamping, certificate) · LibreOffice headless (Word → PDF) · Nodemailer SMTP or Resend (email) · Docker on Fly.io with a persistent volume · Vitest + Playwright.

## Run locally

Needs Node 22.13 or later, for `node:sqlite` without a flag (CI uses Node 24). These run as written in a fresh checkout:

```bash
npm ci
npm run dev            # http://localhost:3000. Data goes to ./data; emails go to the in-app Email log
npx tsc --noEmit       # typecheck
npm run lint
npm test               # vitest: unit, lifecycle, delivery, automation and the tuning-corpus detector report
npm run test:detect    # detector report on all three corpora
npm run build
```

Word uploads need LibreOffice (`soffice`) on the PATH. The Docker image includes it.

**Browser tests** (Playwright) start their own production servers on ports 3100 and 3101, so build first. By default they use the installed Google Chrome. To use Playwright's Chromium instead, set `PW_CHANNEL=chromium`. These need a browser that can be installed or is already present:

```bash
npm run build && npx playwright test
npx playwright install chromium && PW_CHANNEL=chromium npx playwright test
# the grader path on every tuning PDF (17, incl. the 3 converted from Word) instead of the default one
E2E_FIXTURES=$(ls fixtures/agreements/*.pdf | xargs -n1 basename | paste -sd, -) npx playwright test --project=desktop e2e/grader-path.spec.ts
VISUAL=1 npx playwright test e2e/visual.spec.ts   # visual regression; baselines are macOS-only
```

**Docker** (needs a running Docker daemon). Word uploads through LibreOffice, end to end:

```bash
docker build -t countersign . && docker run -p 8080:8080 -e APP_URL=http://localhost:8080 countersign
E2E_BASE_URL=http://localhost:8080 E2E_FIXTURES=15-docx-table-two-column.docx,16-docx-tabstop-signature.docx,17-docx-border-lines-body-blanks.docx npx playwright test --project=desktop e2e/grader-path.spec.ts
```

### Configuration

| env | default | |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public base URL, used in emails and signing links |
| `DATA_DIR` | `./data` | SQLite database + stored PDFs (mount a volume here) |
| `APP_SECRET` | required in production; generated into `DATA_DIR/.secret` in development | Encrypts signing tokens at rest (`lib/secret.ts`). Must never change once links are sent |
| `SMTP_USER` / `SMTP_PASS` (+ `SMTP_HOST`, `SMTP_PORT`) | unset; host defaults to `smtp.gmail.com:465` | Send through any SMTP server. A Gmail account with an app password works with no domain of your own |
| `RESEND_API_KEY` / `EMAIL_FROM` | unset | Send through Resend instead (needs a verified domain). With neither set, emails are recorded in the Email log instead of sent |
| `APP_TZ` | `America/New_York` | Time zone for dates written into agreements |
| `DISABLE_WORKER` | unset | Turns off the reminder/expiry/webhook-retry loop |
| `TRUST_PROXY` | unset | `fly` to read the client IP from Fly's proxy, `1` for a generic X-Forwarded-For proxy. Unset: IPs are recorded as "unknown" (safe default, since headers could be spoofed) |
| `DAILY_FILE_CAP` | `300` | New files per workspace per 24 h (abuse limit) |
| `SOFFICE_PATH` | `soffice` | LibreOffice binary for Word conversion |
| `ALLOW_PRIVATE_WEBHOOKS` | unset | Dev/test only: allow `http://` and private addresses as webhook targets |
| `CONVERTER_URL` | unset; `http://127.0.0.1:8091` in the Docker image | Word conversion service (`scripts/converter.mjs`, run as its own OS user with no access to `DATA_DIR`). Unset: the app runs LibreOffice itself (local dev) |
| `CONVERTER_PORT` | `8091` | Port the conversion service listens on (`scripts/converter.mjs`) |
| `AUTH_RATE_LIMIT_X` | unset | Test servers only: multiplies every `throttle()` limit in `app/actions.ts` (sign-up, sign-in, invites, email confirmation, forgot and reset password) |

## API

Create a key under **Integrations & API** (`app/app/developers/page.tsx`). All endpoints take `Authorization: Bearer cs_live_…`; keys are stored only as hashes (`lib/http.ts`).

| | |
|---|---|
| `POST /api/v1/files` | `{client_name, client_email, agreement_id?, company?, ref?, title?, prefill?: {key: value}, send?: true}` → creates the file and sends it. `agreement_id` comes from `GET /api/v1/agreements` (default agreement if omitted). `ref` is unique per workspace, so a retried request returns 409 instead of double-sending. Errors: 422 `{error}` for validation, 429 for limits |
| `GET /api/v1/files?status=&ref=&limit=` | files with status, timestamps and signing URL (`limit` defaults to 50, max 100). Here `ready_for_work` only means the status is `completed`; nothing is re-checked |
| `GET /api/v1/files/:id` | the same fields for one file, but `ready_for_work` is re-checked (the five readiness checks below, including the sealed PDF's SHA-256), and `readiness` lists each check (`app/api/v1/files/[id]/route.ts`) |
| `GET /api/v1/files/:id/document` | the sealed PDF (`X-Content-SHA256` header); 409 until the file is completed |
| `POST /api/v1/files/:id/remind` · `POST /api/v1/files/:id/void` | send a reminder now (409 unless the file is sent or viewed); void the file (optional `{reason}`). Both return the file object |
| `GET /api/v1/agreements` | agreements, and the prefill blanks each one expects |
| `POST /api/inbound/:token` | no-auth URL for CRMs / Zapier / n8n; same body as `POST /api/v1/files`. Form posts take the flat fields only (`prefill` and `send` need JSON) |

The routes are under `app/api/v1/` and `app/api/inbound/`.

Outbound webhooks (`lib/webhooks.ts`) cover `file.created`, `file.sent`, `file.viewed`, `file.signed`, `file.completed`, `file.declined`, `file.expired` and `file.voided`. Each POSTs `{id, event, created_at, data: <file object>}`, and `file.completed` adds `data.sha256`. They are signed with `X-Countersign-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` and retried with backoff (1, 5, 30, 120 and 720 minutes). A ready-made n8n workflow is at `public/integrations/n8n-countersign.json`.

## Layout

```
app/              pages (marketing, /app firm side, /s/[token] signing room, /verify) and API routes
components/       design-system primitives (ui.tsx, icons.tsx), field editor, signing room, PDF viewer, forms
lib/detect.ts     field detector            lib/pdf/extract.ts  pdf.js text + vector extraction
lib/pdf/stamp.ts  stamping + certificate    lib/files.ts        file lifecycle (send, sign, countersign, seal)
lib/templates.ts  upload + versions         lib/db.ts           schema + migrations (node:sqlite)
lib/dashboard.ts  overview data             lib/library.ts      agreement library data
lib/filepage.ts   file page stages          lib/nav.ts          navigation (finished modules only)
lib/brand.ts      product name and identity in one place (see docs/BRANDING.md)
fixtures/         fake agreements + ground truth (agreements = tuning, holdout, final)
test/             Vitest: detector, lifecycle, automation, delivery, overview, library, file page, stamping, SSRF
e2e/              Playwright: the grader path, phone signing, library and editor, file page, overview,
                  accessibility, responsive layouts, mail, webhooks, and HTTP security (auth, roles, CSRF, isolation)
.github/          CI on pull requests and pushes to main: typecheck, lint, unit, build, Playwright
```
