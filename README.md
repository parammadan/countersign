# Countersign

**Your client agreement, signed on every file, automatically.**

A firm uploads the agreement it already uses (PDF or Word) once. From then on, every new file (one job or case for one client) sends that agreement to the client, chases it, countersigns it for the firm and files the sealed copy. Nobody at the firm has to touch it.

- **Live:** https://countersign-app.fly.dev
- **What was built and why:** [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
- **Original plan:** [`docs/PLAN.md`](docs/PLAN.md)

## Try it in 3 minutes

1. **Create a workspace** at `/signup`. Enter your firm's legal name exactly as it appears in your agreement; that's how your signature block is told apart from the client's.
2. **Agreements → upload** your agreement (or click *Try a sample one*). Countersign reads it and marks every place someone signs, initials, dates or fills a blank: blue for the client, violet for your firm, amber for blanks filled from each file. Fix anything that's off (drag, resize, retype), then **Publish**.
3. **Settings → Firm countersignature**: type or draw it once.
4. **New file**: client name and email. The agreement is filled in and sent right away.
5. Open the signing link (from the email, **Copy signing link** on the file, or **Send a test to me** on the agreement) as the client: consent, review, sign, done. Your countersignature is applied immediately, and both sides get the sealed PDF with a certificate of completion.
6. Check any copy at `/verify`.

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

- **Field detection without an LLM.** It reads signature blocks (`By: ____`, `Signature: ____`, drawn rules with captions under them, `X ____`, dot leaders, signature tables, checkboxes, initials footers), works out which party each block belongs to (defined terms in the preamble such as `("Client")`, headings above each column, the firm's legal name, roles such as "Owner" or "Provider"), and maps body blanks ("Effective Date", "Fee: $____", `and ____ ("Client")`) to file data. Each proposal carries a confidence and a plain-English reason, shown in the editor. If no client signature line exists, a signature page is appended.
- **Accuracy, measured honestly.** Three corpora, all fake documents:

  | corpus | docs | who wrote it | precision | recall |
  |---|---|---|---|---|
  | `fixtures/agreements` (tuning) | 17 (incl. 3 DOCX) | written alongside the detector | 0.99 | 0.96 |
  | `fixtures/holdout` | 9 | written without seeing the detector; then used for tuning | 0.95 | 0.89 |
  | `fixtures/final`, **first run** | 8 | written without seeing the detector; 4 AI/software-consulting agreements in Google Docs / Word layouts + 4 other services agreements | **0.89** | **0.85** |
  | `fixtures/final`, after general fixes | 8 | same | 0.97 | 0.91 |

  The first run on `final` is the honest number for an agreement it has never seen. Client signature lines were found in 8 of 8 documents in that first run. Whatever the detector misses, the admin fixes in the editor before publishing, and publishing is blocked until there is a client signature. Run `npm run test:detect` for the full per-field report.
- **Legal trail.** An ESIGN-style consumer disclosure with logged consent, explicit intent-to-sign, an optional emailed one-time code, an append-only audit log (SQLite triggers reject UPDATE/DELETE) with IP, user agent and timestamps, and SHA-256 of the original, client-signed and final PDFs. The certificate of completion is appended to the final PDF.

## Stack

Next.js 16 (App Router, server actions, route handlers) · React 19 · TypeScript · Tailwind 4 · SQLite via Node's built-in `node:sqlite` (WAL) · pdf.js (extraction + in-browser rendering) · pdf-lib (stamping, certificate) · LibreOffice headless (Word → PDF) · Nodemailer SMTP or Resend (email) · Docker on Fly.io with a persistent volume · Vitest + Playwright.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000. Data goes to ./data; emails go to the in-app Email log
npm test               # unit + lifecycle + detector report
npm run test:detect    # detector on all three corpora
npm run build && npx playwright test   # browser E2E on a production build (uses installed Google Chrome; PW_CHANNEL=chromium to change)
E2E_FIXTURES=$(ls fixtures/agreements/*.pdf | xargs -n1 basename | paste -sd, -) npx playwright test --project=desktop
# Word uploads through LibreOffice: run the Docker image, then
E2E_BASE_URL=http://localhost:8080 E2E_FIXTURES=15-docx-table-two-column.docx,16-docx-tabstop-signature.docx,17-docx-border-lines-body-blanks.docx npx playwright test --project=desktop e2e/grader-path.spec.ts
```

Word uploads need LibreOffice (`soffice`) on the PATH locally. The Docker image includes it.

```bash
docker build -t countersign . && docker run -p 8080:8080 -e APP_URL=http://localhost:8080 countersign
```

### Configuration

| env | default | |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Public base URL, used in emails and signing links |
| `DATA_DIR` | `./data` | SQLite database + stored PDFs (mount a volume here) |
| `APP_SECRET` | generated into `DATA_DIR/.secret` | Encrypts signing tokens at rest |
| `SMTP_USER` / `SMTP_PASS` (+ `SMTP_HOST`, `SMTP_PORT`) | unset; host defaults to `smtp.gmail.com:465` | Send through any SMTP server. A Gmail account with an app password works with no domain of your own |
| `RESEND_API_KEY` / `EMAIL_FROM` | unset | Send through Resend instead (needs a verified domain). With neither set, emails are recorded in the Email log instead of sent |
| `APP_TZ` | `America/New_York` | Time zone for dates written into agreements |
| `DISABLE_WORKER` | unset | Turns off the reminder/expiry/webhook-retry loop |
| `TRUST_PROXY` | unset | `fly` to read the client IP from Fly's proxy, `1` for a generic X-Forwarded-For proxy. Unset: IPs are recorded as "unknown" (safe default, since headers could be spoofed) |
| `DAILY_FILE_CAP` | `300` | New files per workspace per 24 h (abuse limit) |
| `SOFFICE_PATH` | `soffice` | LibreOffice binary for Word conversion |
| `ALLOW_PRIVATE_WEBHOOKS` | unset | Dev/test only: allow `http://` and private addresses as webhook targets |

## API

Create a key under **Integrations & API**. All endpoints take `Authorization: Bearer cs_live_…`.

| | |
|---|---|
| `POST /api/v1/files` | `{client_name, client_email, agreement_id?, company?, ref?, title?, prefill?: {key: value}, send?: true}` → creates the file and sends it. `agreement_id` comes from `GET /api/v1/agreements` (default agreement if omitted). `ref` is unique per workspace, so a retried request returns 409 instead of double-sending. Errors: 422 `{error}` for validation, 429 for limits |
| `GET /api/v1/files?status=&ref=&limit=` · `GET /api/v1/files/:id` | status, timestamps, signing URL (`limit` defaults to 50, max 100) |
| `GET /api/v1/files/:id/document` | the sealed PDF (`X-Content-SHA256` header) |
| `POST /api/v1/files/:id/remind` · `POST /api/v1/files/:id/void` | |
| `GET /api/v1/agreements` | agreements, and the prefill blanks each one expects |
| `POST /api/inbound/:token` | no-auth URL for CRMs / Zapier / n8n; same body as `POST /api/v1/files`. Form posts take the flat fields only (`prefill` and `send` need JSON) |

Outbound webhooks (`file.created`, `file.sent`, `file.viewed`, `file.signed`, `file.completed`, `file.declined`, `file.expired`, `file.voided`) POST `{id, event, created_at, data: <file object>}` (`file.completed` adds `data.sha256`). They are signed with `X-Countersign-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` and retried with backoff. A ready-made n8n workflow is at `public/integrations/n8n-countersign.json`.

## Layout

```
app/            pages (marketing, /app firm side, /s/[token] signing room, /verify) and API routes
components/     field editor, signing room, PDF viewer, signature pad, forms
lib/detect.ts   field detector            lib/pdf/extract.ts  pdf.js text + vector extraction
lib/pdf/stamp.ts  stamping + certificate  lib/files.ts        file lifecycle (send, sign, countersign, seal)
lib/templates.ts  upload + versions       lib/db.ts           schema + migrations (node:sqlite)
fixtures/       fake agreements + ground truth (agreements = tuning, holdout, final)
e2e/            Playwright: the grader path end to end
```
