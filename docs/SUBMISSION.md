# AgreementOS: submission overview

Written from the code on `main`. Paths are relative to the repository root. The README has the full feature table with tests.

## What it is

AgreementOS is a multi-tenant web app (Next.js 16, SQLite through `node:sqlite`) that gets a firm's standard client agreement signed on every new client file. A firm uploads its agreement once, reviews the fields the app detects, and publishes it. After that, each new file is sent to the client, signed, countersigned by the firm and sealed. A set of AI features, using Claude, also helps firms read, ask about and draft agreements.

## Features and where they live

**E-signing (M0 and M1)**
- Upload PDF or Word (Word goes through LibreOffice): `components/UploadAgreement.tsx`, `lib/convert.ts`, `lib/templates.ts`.
- Field detection without an LLM, with a confidence and reason per field: `lib/detect.ts`, `lib/pdf/extract.ts`. Editor and publish: `components/FieldEditor.tsx`, `lib/fields.ts`. Publishing needs a client signature, and published versions are immutable.
- New files from the app, CSV, REST API (`app/api/v1/`, `GET /api/v1/files` pages with `starting_after`) or an inbound webhook URL: `lib/files.ts`, `app/actions.ts`.
- Client signing room with consent, draw or type signature, decline, optional emailed code: `app/s/[token]/page.tsx`, `components/SigningRoom.tsx`, `lib/signer.ts`.
- "Sign on your phone": on a desktop-sized screen the signing room shows a QR code of the same signing link, made on the server (`lib/qr.ts`). The page polls a status route until the phone finishes: `components/SignOnPhone.tsx`, `app/api/sign/[token]/status/route.ts`.
- "Scan with phone": the upload screen shows a QR code; the phone photographs one or more pages (JPEG only), and the desktop receives them as one PDF that goes into the normal field review. Nothing is published or sent automatically: `lib/scan.ts`, `app/api/scan/`, `components/scan/`.
- Countersign (automatic by default, manual button if turned off): `lib/files.ts` (`countersign`). Reminders and expiry: `lib/worker.ts`.
- Sealed PDF with a certificate of completion, SHA-256 hashes and an append-only audit log: `lib/pdf/stamp.ts`, `lib/audit.ts`, `lib/db.ts` (triggers). Any copy can be checked at `/verify`: `app/verify/page.tsx`.

**M2.1 Document understanding**: rule-based reading of an agreement that quotes what it finds and says "not found" otherwise: `lib/understand/rules.ts`, `lib/understand/evidence.ts`, `lib/understand/store.ts`.

**M2.2 Ask about an agreement** (`app/app/agreements/[id]/ask/page.tsx`, `lib/qa/`)
- Claude answers from the agreement with quoted citations and page numbers (`lib/qa/answer.ts`). Without a model, it shows the most relevant passages instead.
- Before an answer is shown, citations are checked against the passages, figures, dates, names and negations must appear in the cited text, and arithmetic is redone in code (`lib/qa/check.ts`).
- A second, independent Claude call judges the answer claim by claim against the whole agreement (`lib/qa/verify.ts`); mechanical rules decide what its verdicts allow.
- Answers that fail are withheld and the passages are shown instead, with a reason that names the kind of problem but not the failing claim.

**M2.3 Agreement Studio** (`app/app/studio/`, `lib/drafts/`, `lib/m23/`, `components/studio/`)
- The user describes an agreement; Claude only suggests form values (parties, terms), which the user reviews. The agreement is then generated from reviewed templates (services, NDA, lease, retainer, engagement, consulting, licence) in `lib/m23/m23-generate/templates/`.
- Voice input fills the description box using the browser's speech recognition. It never submits, and AgreementOS does not record or store audio (`components/studio/VoiceInput.tsx`).
- Editing with proposed changes and a diff, saved versions, and approval: `lib/m23/m23-editor/`. Approval needs an owner or admin who did not author or last edit the draft (`lib/drafts/roles.ts`; a database check also enforces it).
- Export to PDF or DOCX: `lib/m23/doc-output/`, `lib/drafts/service.ts` (`exportDraft`). Approved drafts can be published into the agreement library.

**M3 Knowledge Hub** (`app/app/knowledge/page.tsx`, `lib/m3/`): indexes a workspace's agreements and answers questions across them. Search is filtered by the user's permission, every citation is verified, and when evidence is insufficient it abstains rather than answering. With no model it quotes passages.

**Document Intelligence** (`app/app/documents/`, `lib/intake/`)
- Reads an uploaded document with rules (type, parties, dates, amounts, governing law, signature blocks, conflicts, missing fields).
- With AI, Claude analyses it and every finding carries a quote that must really be in the document (`lib/intake/ai-service.ts`, `lib/understand/evidence.ts`).
- "Chat with one document" reuses the M2.2 answer, checks and verifier.
- A "Start a draft in Agreement Studio" handoff fills Studio's form only with values the document states (`components/intake/DraftFromIntake.tsx`).

**Clause Library** (`app/app/clauses/`, `lib/clauses/`): reusable clauses with placeholders, versions and a draft, review, approved, retired lifecycle. Editing never implies approval, and an author cannot approve their own version. Changes and uses in Studio are written to the audit log. Markup-like text is rejected (`lib/clauses/safety.ts`).

## AI safety model

- **One daily spending cap** for every paid model call, all features together (`lib/ai/budget.ts`, `AI_DAILY_USD_CAP`, default $5; production sets $10). There are also per-workspace and new-workspace caps.
- **Metered calls**: each call reserves its worst-case cost first and books the actual cost afterwards.
- **Confirmed-email rule**: only workspaces whose owner confirmed their email may use AI. With no email provider, nothing can be confirmed, so AI stays off.
- **Off by default**: a model is used only when `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set on the server (`lib/ai/anthropic.ts`). Every AI feature falls back to rules or quoted passages.
- **Injection quarantine**: text that reads like instructions to software is set aside, blanked before any model sees it, and not indexed (`lib/intake/`, `lib/qa/retrieve.ts`, `lib/m3/`). A document whose scan did not finish is never sent to a model. Documents, questions and answers are treated as data, and the models have no tools.
- **Evidence grounding**: a model's finding or citation is only shown as stated if its quote is found in the document (`lib/understand/evidence.ts`). Models never decide figures, parties, dates or approvals in Studio.

## Security model

- **Workspace isolation**: every query is scoped by the workspace from the server session, never from request input. Another workspace's record is reported as "not found".
- **Roles**: owner, admin, staff. Staff cannot see admin pages, approve drafts or clauses, or publish (`lib/nav.ts`, `lib/drafts/roles.ts`, `lib/clauses/`).
- **Tokens and keys are hashed**: session ids, API keys, invite and signing tokens are stored as SHA-256 hashes (`lib/auth.ts`, `lib/http.ts`, `lib/files.ts`). Signing tokens are also stored encrypted with `APP_SECRET` (`lib/secret.ts`).
- **Rate limits**: sign-in, sign-up, invites, password reset, email codes, signing codes, per-user AI questions and indexing, a daily file cap and a per-workspace 24-hour cap on client invitations (`lib/ratelimit.ts`, `lib/sendcap.ts`, `app/actions.ts`). Mutating requests have CSRF and origin checks (`lib/http.ts`).
- **Webhooks** are signed and checked against SSRF (`lib/webhooks.ts`, `lib/ssrf.ts`).

## Run locally

Needs Node 22.13 or later. From `package.json` and the README:

```bash
npm ci
npm run dev            # http://localhost:3000; data in ./data; email goes to the in-app Email log
npx tsc --noEmit && npm run lint
npm test               # vitest
npm run test:detect    # detector report on the three fixture sets
npm run build && npx playwright test   # browser tests (PW_CHANNEL=chromium to use Playwright's Chromium)
```

Create a workspace at `/signup`, upload an agreement (or use "Try a sample one"), publish, set the countersignature in Settings, then create a file. Word uploads need LibreOffice (`soffice`). AI features need the two environment variables above and a confirmed owner email, so with default local settings they are off. Other settings are in the README's Configuration table.

## Limitations

- Field detection is rule-based and will miss or mislabel some fields on unfamiliar layouts. The admin corrects them in the editor. The README reports precision and recall on fake documents, and notes that the held-out sets are no longer unseen.
- One client signer per file, plus the firm. Agreement text is fixed; only the blanks change per file.
- Studio fills the reviewed templates only. It does not write free-form clauses, and what a template cannot include is listed, not added.
- Q&A and Knowledge Hub may withhold an answer or abstain, and then show passages only. Answers are only as good as the extracted text. Scanned pages are flagged by the detector.
- Voice input needs a browser with speech recognition; elsewhere the control is not offered.
- AI is capped daily, so it can be unavailable for the rest of the day once the cap is reached.
- Clause Library compares user ids, so one person with two accounts in a workspace could approve their own text. It is recorded in the audit log.
- Outbound webhooks are built and tested but external delivery is turned off in production for this submission.
- Email goes to the Email log unless SMTP or Resend is configured.
- Some paths have no automated test (see the README's Tests column), and visual baselines exist only on macOS.
