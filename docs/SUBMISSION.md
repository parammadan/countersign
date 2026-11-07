# AgreementOS: submission

- **Submission URL:** https://countersign-app.fly.dev
- **Repository:** https://github.com/parammadan/countersign (private; `theastraway` invited as a collaborator)
- **Email on the demo:** if an email doesn't arrive (check spam), every message is also under **Email log**, and each file has **Copy signing link**.

## What I built

AgreementOS is a multi-tenant SaaS product that makes "the agreement every client signs before work starts" happen by itself on every file.

A firm sets it up once:
- Upload the agreement it already uses (PDF or Word).
- Check the signature, date and blank fields AgreementOS found.
- Adopt a countersignature.

After that, every new file, whether opened in the app, imported from CSV, posted by a CRM or n8n, or created through the REST API, does all of this with nobody at the firm touching it:
- fills the agreement in with the client's details
- emails the client a personal signing link
- sends reminders on days 2 and 5 (configurable), and expires the link after 14 days
- collects a legally sound electronic signature on any device
- applies the firm's countersignature the moment the client signs
- seals the PDF with a certificate of completion and SHA-256 fingerprints
- emails both sides the signed copy
- fires a webhook so the firm's other systems can mark the file "cleared to start"

The firm watches it all from the **Overview** (`app/app/page.tsx`, `lib/dashboard.ts`). It shows:
- who's waiting, and for how long
- what needs attention: an email that failed, a file waiting on a manual countersignature, a signed copy that wasn't delivered, a decline, an expired link, or a file unsigned for 3 days or more
- one recommended next step and the latest activity

Each client file has its own page (`app/app/files/[id]/page.tsx`, `lib/filepage.ts`). It shows where the file is, which reminders are planned and what happens next. Every automated step can also be run by hand from there: remind, resend, copy the signing link, countersign, void, and re-send the signed copy (`components/FileActions.tsx`).

### The firm's workspace (M1)

The first milestone (M1) of the redesign rebuilt the firm side of the app:
- **Design system:** colour tokens in `app/globals.css`, and shared components and icons in `components/ui.tsx` and `components/icons.tsx`.
- **App shell:** navigation that only lists finished modules and hides admin pages from staff (`lib/nav.ts`, `components/Nav.tsx`).
- **Overview:** `lib/dashboard.ts`; tested by `test/dashboard.test.ts` and `e2e/overview.spec.ts`.
- **Agreement library:** live, draft and archived views, search, version history, archive and restore, and upload progress (`lib/library.ts`, `app/app/agreements/page.tsx`). Tested by `test/library.test.ts` and `e2e/agreements.spec.ts`.
- **Field editor:** a toolbar, a field list, keyboard moves, fields kept inside the page, overlap warnings and a confirmation before publishing (`components/FieldEditor.tsx`, `components/PdfPages.tsx`). Tested by `e2e/agreements.spec.ts`.
- **Client file page:** described above. Tested by `test/filepage.test.ts`, `test/copyresend.test.ts`, `e2e/file-workspace.spec.ts` and `e2e/mail-flow.spec.ts`.

Accessibility (`e2e/a11y.spec.ts`, axe with WCAG 2.1 A + AA rules) and phone and tablet layouts (`e2e/responsive.spec.ts`) are checked in the browser suite. The README has the full feature table, with the code and tests behind each row.

**How the brief's hard requirement is met:** "it has to work with an agreement it has never seen". The core is a deterministic field detector (`lib/detect.ts`, scored by `test/detect.test.ts`).
- **What it reads:** the uploaded document's text positions and drawn lines.
- **What it finds:** signature blocks, dates, names, titles, initials, checkboxes, signature tables, and blanks in the body text.
- **How it assigns parties:** it works out which party each block belongs to from the preamble's defined terms, the headings above each column, the firm's legal name and common role words.
- **The editor as safety net:** anything it gets wrong, the admin fixes in the editor in seconds, and publishing is blocked until the client has a place to sign.
- **No signature line at all:** if the agreement has none, a signature page is added automatically (`lib/templates.ts`, tested in `test/flow.test.ts`).

So an unseen agreement always ends in a signed, sealed document, and usually with no manual correction.

## Assumptions I made (the brief said to decide and write it down)

1. **"Our industry" = professional services that run work as files** (agencies and AI consultancies like Astra, law, accounting, staffing, contractors). Nothing in the product is specific to one of them, so it can be sold across all of them.
2. **One file = one client signer + the firm.** That's what "every client we take on has to sign the same agreement" describes. Multiple client signers are listed under "left out".
3. **The agreement's legal text is fixed; only the blanks change per file.** The product never edits clauses.
4. **U.S. law (ESIGN Act / UETA) is the bar**: a simple electronic signature with a strong audit trail, which is what U.S. firms use day to day.
5. **The firm countersigns automatically** with a signature its authorised person adopts once. That is the "no human touches it" outcome. Firms that want to review first can turn it off, and then a "Countersign and complete" button appears on the file (`lib/files.ts` `countersign`; `test/automation.test.ts` "holds for manual countersign when auto is off").

## Features I included, and why

| Feature | Why it's in | Where (code · tests) |
|---|---|---|
| **Upload any PDF or Word agreement, with automatic field detection** | The grader's test, and the real job: firms already have an agreement and won't re-type it into a template builder. Deterministic, so the same document gives the same result, it costs nothing per file, and every field comes with a reason the admin can read. | `lib/detect.ts`, `lib/convert.ts`, `lib/templates.ts` · `test/detect.test.ts`, `test/flow.test.ts` |
| **Field editor (drag, resize, retype, reassign party, prefill mapping)** | Detection will never be perfect on unseen documents (measured below), so a fast human fix is what makes it safe to sell. Colour-coded by who fills each field. | `components/FieldEditor.tsx`, `lib/fields.ts` · `e2e/agreements.spec.ts` |
| **"Try a sample" and "Send a test to me"** | A prospect can see the whole flow in under three minutes before trusting it with their own document, and a firm can check exactly what its clients will see. | `app/api/agreements/sample/route.ts`, `app/actions.ts` · `e2e/grader-path.spec.ts` |
| **Signature page fallback** | An agreement with no signature line can still be signed. No dead ends. | `lib/templates.ts` · `test/flow.test.ts` |
| **Immutable agreement versions** | Each file records exactly which version was signed. Editing creates a new version and never changes what a client already signed. | `lib/templates.ts` · `test/flow.test.ts`, `e2e/agreements.spec.ts` |
| **Agreement library: live, draft and archived, search, version history** | A firm with several agreements (or several versions of one) can see which is live and roll back without losing what was signed. | `lib/library.ts`, `app/app/agreements/page.tsx` · `test/library.test.ts`, `e2e/agreements.spec.ts` |
| **New files from the app, CSV, REST API, inbound webhook, and an n8n workflow** | "Automates getting that agreement signed on every file" means it has to start where the file is born, which is usually a CRM. The inbound URL needs no code. The n8n template fits Astra's own stack. | `components/NewFileForm.tsx`, `app/actions.ts`, `app/api/v1/files/route.ts`, `app/api/inbound/[token]/route.ts`, `public/integrations/n8n-countersign.json` · `test/flow.test.ts` (`createFile`, which every route calls), `e2e/grader-path.spec.ts` (from the app), `test/csv.test.ts` (parsing only); a successful API or inbound create isn't tested |
| **Prefill from file data** | Client name, company, date and custom blanks (fee, scope) are filled in per file, so the same agreement works for every client. | `lib/files.ts` (`prefillValues`) · no automated check of the filled-in values |
| **Branded signing room: consent, guided "next field", draw or type, mobile-first, decline with a reason** | Clients sign in about two minutes, on their phone, with no account. Declines tell the firm why. | `components/SigningRoom.tsx`, `components/SignaturePad.tsx`, `lib/consent.ts` · `e2e/grader-path.spec.ts`, `e2e/signing-mobile.spec.ts`, `test/automation.test.ts` |
| **Automatic countersignature** | Removes the last manual step and the reason files sit idle. | `lib/files.ts` (`countersign`) · `test/flow.test.ts`, `test/automation.test.ts` |
| **Reminders + link expiry + "needs attention" on the Overview** | Chasing is the slow part of the manual process. It runs on a schedule (default: reminders on days 2 and 5, expiry at 14 days), and files that are stuck surface on their own. | `lib/worker.ts`, `lib/dashboard.ts` · `test/automation.test.ts`, `test/dashboard.test.ts`, `e2e/overview.spec.ts` |
| **Client file page: stages, reminder plan, next step, ready-for-work checks** | Staff can see at a glance where a file is and what to do, and act on it without leaving the page. | `app/app/files/[id]/page.tsx`, `lib/filepage.ts`, `components/FileActions.tsx` · `test/filepage.test.ts`, `e2e/file-workspace.spec.ts` |
| **Certificate of completion, SHA-256 seals, append-only audit log, public /verify page** | What makes an e-signature hold up later. Every event is recorded with IP, user agent and timestamp; the database rejects edits and deletes of the log; any copy can be checked for tampering. | `lib/pdf/stamp.ts`, `lib/audit.ts`, `lib/db.ts`, `app/api/verify/route.ts` · `test/flow.test.ts`, `e2e/grader-path.spec.ts` |
| **ESIGN-style consumer disclosure, logged consent, explicit intent-to-sign, optional emailed one-time code** | Consent to electronic records is required before signing; the code is an extra identity step for firms that need it. | `lib/consent.ts`, `lib/signer.ts`, `lib/files.ts` · `test/automation.test.ts` |
| **Editor undo, idempotent file creation (a repeated `ref` returns 409), HSTS + Content-Security-Policy** | Small things that stop costly mistakes: a mis-drag, a CRM retrying a webhook and double-sending, a script-injection attempt. | `components/FieldEditor.tsx`, `lib/files.ts`, `next.config.ts` (headers in production builds) · `e2e/agreements.spec.ts`, `test/flow.test.ts` |
| **Workspaces, team invites with admin/staff roles, branding, sender name and reply-to** | So it's a product any firm can sign up for and run, not a tool for one firm. Staff can open files; only admins can change the agreement or settings. | `app/actions.ts`, `lib/auth.ts`, `lib/nav.ts` · `e2e/security.spec.ts` (roles; branding and member management have no automated test) |
| **Signed outbound webhooks with retries, API keys stored as hashes, CSV export** | So firms can plug it into the systems they already run, and keep their data. | `lib/webhooks.ts`, `lib/http.ts`, `app/api/files/export/route.ts` · `test/automation.test.ts`, `e2e/webhook.spec.ts` |
| **Email log** | Every email the system sent, viewable in the app, which helps with support and deliverability questions. The personal links and one-time codes in signing, invite, reset and code emails are withheld from the stored copy. | `lib/email.ts`, `app/app/outbox/page.tsx` · `test/flow.test.ts`, `test/automation.test.ts` |
| **Password reset, team management (remove, change role, revoke invites), rate limiting, CSRF/origin checks, SSRF-guarded webhooks, encrypted signing tokens** | Basics a company would expect before trusting it with client documents. | `app/actions.ts`, `lib/ratelimit.ts`, `lib/http.ts`, `lib/ssrf.ts`, `lib/secret.ts` · `e2e/security.spec.ts` (sign-in, roles, CSRF), `test/ssrf.test.ts`; rate limits untested |

## Features I deliberately left out, and why

| Left out | Why |
|---|---|
| **Billing / Stripe checkout** | Astra is the first customer, and the pilot doesn't need a card form. It doesn't get a single agreement signed faster. Pricing would be per workspace per month plus per completed file, added once a second firm signs up. |
| **Multiple client signers and signing order** | The brief describes one client per file. The data model keeps signatures per role, so N signers is an extension, not a rewrite. |
| **Editing agreement text in the app** | The legal text is the firm's, and changing it inside our tool creates liability for them and for us. To change it, they upload a new version. |
| **OCR for scanned PDFs** | A heavy dependency for an edge case. Scanned pages are detected and flagged; the signature page fallback and the editor still get them signed. |
| **LLM-based field detection** | It would make the core flow cost money per file, depend on a third party and give different results on the same document, and agreements are sensitive. The deterministic detector scores well (below), and the editor covers the rest. An optional LLM pass for low-confidence fields is the obvious next step, behind a per-workspace opt-in. |
| **Certificate-based (PAdES/PKI) digital signatures, eIDAS QES** | These need a CA-issued certificate and per-jurisdiction legal work. For U.S. firms, ESIGN/UETA with an audit trail and tamper-evident hashes is the market standard (it's what the big e-signature tools use by default). |
| **SMS codes, ID verification (KBA)** | Email possession plus an optional email code is the baseline for client engagement letters. SMS adds a vendor and per-message cost. |
| **SSO/SAML, SOC 2 artifacts, data-residency options** | Enterprise-sales features, not needed to buy and run it at small-firm size. |
| **Native mobile apps** | Clients sign in the browser, and the signing room is built mobile-first. Nobody installs anything to sign one agreement. |
| **Collecting a payment or retainer at signing** | A separate product decision, and easy to add after signing. |
| **Per-user workspace switching** | A person belonging to several firms signs in to the first one. Rare for a firm's staff; worth adding once firms share contractors. |
| **Postgres and multi-instance hosting** | One instance with SQLite in WAL mode on a persistent volume handles thousands of files a day for a firm and is simpler to run and back up. The SQL is plain enough to move to Postgres when there are many tenants. |

## Security review

Before launch I had a separate Claude Code session do a read-only security and correctness review, with no hand-off of my own reasoning. It found no critical issues, 5 high, 9 medium and 12 low. I fixed all the high and medium ones. The riskiest have automated tests:

| Fix | Test |
|---|---|
| Rotated-page stamping, all four rotations, with and without crop boxes | `test/stamp.test.ts` |
| SSRF checked at connect time | `test/ssrf.test.ts` |
| One-time codes stored hashed and kept out of the log | `test/automation.test.ts` "emailed codes: stored hashed, kept out of the log, 5 tries" |
| Signed webhooks and retries | `test/automation.test.ts` "delivers signed webhooks and retries failures", `e2e/webhook.spec.ts` |
| A second countersign is refused | `test/automation.test.ts` "holds for manual countersign when auto is off" |
| Failed email delivery | `test/delivery.test.ts`, `test/copyresend.test.ts`, `e2e/mail-flow.spec.ts` |
| The sign-up verification gate | `test/delivery.test.ts` |
| Readiness re-checks | `test/flow.test.ts`, `test/filepage.test.ts`, `e2e/security.spec.ts` (`GET /api/v1/files/:id`) |
| Sign-in, sessions, roles, CSRF and isolation between workspaces, over HTTP | `e2e/security.spec.ts` |

CI (`.github/workflows/ci.yml`) runs them on every pull request and every push to `main`. The rest were verified by reading the code and by a second, independent audit. The fixes:

- **Sensitive emails:** the code in one-time-code emails, and the links in invite, password-reset and email-confirmation emails, are withheld from the stored copy in the in-app Email log (`lib/email.ts`). The email is still listed, but staff can't read a link from it and take over an account.
- **Rotated pages:** stamps are mapped through the page's `/Rotate` and crop box, so signatures on landscape or rotated pages land where the editor showed them. This is tested at all four rotations, with and without crop boxes, including that the text reads upright.
- **Request size:** bodies are capped while streaming, before parsing, so an oversized upload can't take down the server.
- **LibreOffice:** Word files are converted by a separate small service running as its own OS user, which cannot read `/data` (the database, every firm's PDFs, the app secret). It has no app secrets in its environment and a 60-second timeout that kills the whole process group (`scripts/converter.mjs`), and the app sends it at most two conversions at once (`lib/convert.ts`). Verified in the Docker image: the converter user gets "Permission denied" on `/data`, and Word uploads still sign end to end.
- **Email code:** the verified code is tied to the client's browser (an httpOnly cookie, `lib/signer.ts`), not to the file, so a forwarded link alone can't sign. Nothing about the agreement is sent to the browser before verification.
- **Countersigning:** it is atomic (`lib/files.ts` `countersign`: an in-process lock plus a conditional update). A double click, or a void during auto-countersign, can't produce two sealed copies, and the audit event is written only once the sealed PDF exists. If auto-countersign fails, the client still sees success and the firm is asked to countersign by hand.
- **Webhooks:** deliveries are claimed before sending, so there are no duplicates. Removed webhooks stop retrying. DNS is checked at connect time, so a hostname can't pass the check and then point at an internal address.
- **Client IPs:** they come only from the trusted proxy (Fly), so they can't be spoofed into the audit trail.
- **Team:** admins can remove members and change roles, and invites expire after 7 days.
- **Email delivery is reported honestly:** if the provider rejects or can't reach an email, the file records the failure and the error, the audit trail says "Email to client failed" instead of "sent", the `file.sent` webhook isn't fired, and the file page tells the firm to copy the link or retry.
- **Sign-up abuse:** when real email is configured, a new workspace must confirm its owner's address (one-click link, a button rather than a GET so mail scanners can't trigger it) before it can email anyone outside its own team, or invite teammates. "Send a test to me" works straight away.
- **Signing links:** they are withheld from the stored copy of every email, so staff reading the Email log can't use a client's link. A completed file's link opens the client's copy for 30 days, then closes (the copy is also emailed).
- **Ready for work:** a completed file is only shown as ready after re-checking five things: consent, the client's signature, the firm's countersignature, that the sealed PDF on disk still matches its recorded SHA-256, and that the file hasn't been voided. The same check is in `GET /api/v1/files/:id` (`e2e/security.spec.ts`); the file list in `GET /api/v1/files` only reports whether the status is completed.
- **Smaller fixes:** signature images are capped by pixel size; each workspace has a daily cap on new files; the "client opened it" event is recorded from the browser, so email link scanners don't fake it; `/verify` says when a file was voided; fillable PDF form fields are flattened so they can't hide stamps.

**Residual risks, accepted for now and written down here:**
- The Word converter is isolated from the data by OS user, not by a separate machine or network namespace. A sandbox (gVisor, a separate Fly machine) is the next step for high-volume use.
- One machine: locks, rate limits and the reminder loop live in the app process, and SQLite is on one volume (Fly's scheduled volume snapshots are on, kept 5 days; restores have not been rehearsed). That is deliberate for this stage; moving to several machines needs Postgres and a job queue first.
- No MFA for firm users yet.

**Not covered by automated tests yet:**
- **Covered only by reading the code:** CSV import and export end to end (only the CSV parser is tested), the n8n template, workspace branding, team management (remove, change role, revoke, the 7-day invite expiry), the one-time-code browser cookie, `GET /api/v1/agreements`, and the `X-Content-SHA256` header.
- **Opt-in test only:** password reset is covered by `e2e/real-email.spec.ts`, which needs a test mailbox.
- **No dedicated test:** webhook claim-before-send.
- **No automated test:** a successful file create through the REST API or the inbound webhook URL, and `POST /api/v1/files/:id/remind` and `/void` (the browser suite only checks that another workspace's key gets 404); rate limits and `DAILY_FILE_CAP` (no test reaches a 429); the publish gate that requires a client signature (`validateForPublish`); and the prefill values written into the agreement (tests fill blanks in, but don't check the values).
- **Sequential only:** the double-countersign guard is tested one call after another, not under concurrent clicks.

## How well it handles an agreement it has never seen

I measured the detector on fake agreements in three groups, matching each detected field to ground truth by page, type, party and position:

| corpus | precision | recall |
|---|---|---|
| Tuning set (17 docs, incl. 3 Word files converted by LibreOffice) | 0.99 | 0.96 |
| Held-out set (9 docs, written without seeing the detector, later used for tuning) | 0.95 | 0.89 |
| **Final set, first run** (8 docs, written without seeing the detector: 4 AI/software-consulting agreements laid out like Google Docs and Word exports, plus 4 other professional-services agreements; all generated by `scripts/make-final.mjs`) | **0.89** | **0.85** |

On that first final run, the client's signature line was found in **8 of 8** documents, and the firm's in 7 of 8. That first run is the best estimate for an agreement it has never seen, such as the MIND client agreement the graders will upload. To reproduce it, start from a clean working tree. Use the detector from commit `d9b03cd` (before that round of fixes) with the final set, which was added after that commit:

```bash
git checkout d9b03cd && git checkout origin/main -- fixtures/final
FIXTURE_DIR=fixtures/final npx vitest run test/detect.test.ts   # OVERALL precision=0.888 recall=0.853
git reset -q --hard && git checkout -   # back to where you were
```

After one round of general fixes, the same set scores 0.97 / 0.91 today (`npm run test:detect`). Since the final set has now been used for fixes, it isn't unseen any more, and the next new set is the honest measure. The misses that remain are mostly empty cells in order-form grids, which the admin adds in the editor.

**Grader simulation.** Last, a fresh agent played the grader on the live site. It wrote three new MIND-style agreements of its own (a Word file with a signature table split across pages, a Google-Docs-style PDF, and an order form with captions under the signature lines) and took each through the whole path, on desktop and on a phone. All three reached a sealed, verifiable PDF with no errors, and the client and firm signature blocks were found and assigned to the right party every time. On the first run it also found real misses:
- Name, title and date rows in the Word table and in the captions-under layout were skipped.
- "Customer signatory email" was typed as a signature.

These are now fixed as general rules, checked against all three corpora so nothing regressed. The fix: a field word such as email, name or date now beats a signature word.

The full browser flow is one automated test, `e2e/grader-path.spec.ts`: upload → publish → adopt countersignature → new file → client signs → countersigned → sealed PDF verifies, and a tampered copy fails. By default it runs on one tuning PDF. With `E2E_FIXTURES` it runs on all 17 tuning PDFs, including the scanned ones and the 3 converted from Word (the README has the command). The 3 Word files themselves go through the same test against the production Docker image, where LibreOffice does the conversion. `e2e/signing-mobile.spec.ts` runs the same path on a phone-sized screen. The owner also ran it against the live site, for a PDF and a Word file, on desktop and on a phone. That run needs production access, so it is done only from the owner's machine.

## Tools I used

- **App:** Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **Data:** SQLite through Node's built-in `node:sqlite`
- **PDF:** pdf.js (Mozilla) for text and vector extraction and in-browser rendering; pdf-lib for stamping and the certificate
- **Word documents:** LibreOffice (headless), to convert them to PDF
- **Email:** Nodemailer over SMTP (works with a Gmail account and an app password, so no domain is needed), or Resend
- **Hosting:** Docker on Fly.io
- **Testing:** Vitest and Playwright
- **AI assistant:** Claude Code (Anthropic), for planning, writing code and generating the fake test agreements. Two of the test sets were written by separate Claude Code agent sessions that were not allowed to read the detector's source, so their scores are a fair test.

All data in the repo and the demo is fake test data.
