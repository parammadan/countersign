# Countersign: implementation plan

Working name. Rename freely before submission.

## 1. What the client actually asked for

> "Every client we take on has to sign the same agreement before we can start work. Right now that is manual, and it slows down every file. I want something that automates getting that agreement signed on every file. Once it works for us, I want to sell it to every other company in our industry."

What that means in practice:

| Client words | Requirement |
|---|---|
| "the same agreement" | One **reusable agreement template** per firm, set up once, versioned |
| "on every file" | A **file** (one job/case for one client) is the unit. Creating a file has to trigger the agreement automatically |
| "automates" | Nobody at the firm touches it after the file exists: prefill, send, remind, countersign, store, notify. A human only steps in on exceptions |
| "slows down every file" | Track the signing status of every file, and show what's blocking work |
| "sell it to every other company" | **Multi-tenant SaaS**: self-serve signup, a workspace per firm, branding, team members, API. No Astra-specific code paths |
| "an agreement it has never seen" (grader) | Accepts **any PDF or DOCX**. **Detects signature, name and date fields automatically**, and a firm user can **confirm or fix them in under a minute** |

**Grader path that must never break:** sign up → upload an unseen agreement → review the detected fields → create a file for a test client → client opens the link → signs → firm countersign is applied automatically → both sides get the signed PDF with an audit certificate. That flow is the acceptance test, and it runs end to end against the deployed URL every day from Day 3 on.

### Assumptions (written down, per the brief)
- "Industry" = professional services that run work as files/cases/engagements (AI consultancies and agencies like Astra, law, accounting, insurance, staffing). Nothing in the product is specific to one of them.
- A file has **one client signer**, and the **firm countersigns**. That covers a standard engagement/client agreement. Multiple client signers are listed under "left out".
- The agreement text is fixed. Only blanks (client name, date, fee, address and similar) change per file. The product doesn't edit legal text.
- U.S. ESIGN Act / UETA is the legal bar (simple electronic signature with a strong audit trail), not eIDAS QES.

## 2. Product: the three users

1. **Firm admin** (setup, once): creates a workspace, uploads the agreement, confirms the fields, sets the firm's countersigner and their adopted signature, branding, reminders, and an API key or webhook.
2. **Firm staff** (each file): creates a file (UI, CSV, API, or n8n/Zapier webhook) with the client name and email plus any custom fields. Everything after that is automatic. A **command center** dashboard shows every file's status, and any step can be fired manually (resend, remind, void, download). This matches how Astra builds for its own clients: a UI where the process can be run by hand, and is then automated.
3. **Client signer** (no account): gets a branded email → opens a secure link → gives consent to sign electronically → reviews the whole document → fills their fields → draws or types a signature → signs → downloads the completed PDF. Works on a phone.

### File lifecycle (state machine)
`draft → sent → viewed → signed_by_client → completed` plus `declined`, `expired`, `voided`.
- `completed` = firm countersign applied, final PDF sealed, certificate appended, everyone emailed, `file.agreement_completed` webhook fired.
- Every transition writes an **append-only audit event** (actor, timestamp, IP, user agent, document hash).

## 3. Architecture

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js (App Router) + TypeScript**, one codebase for UI + API routes | Fast to build, one deploy |
| DB / Auth / Storage | **Supabase**: Postgres + Row-Level Security per workspace, email/password + magic-link auth, private storage buckets | Real multi-tenancy (RLS) without writing an auth system; Param has shipped on it before |
| PDF | **pdf.js** (render + text positions for detection), **pdf-lib** (stamp fields, signatures, certificate) | Both pure JS, no native deps |
| DOCX → PDF | **LibreOffice headless** in the app container | One canonical PDF pipeline. Everything downstream (detection, stamping, hashing) only knows PDF |
| Email | **Resend** (free tier) | Simple API, delivery webhooks |
| Hosting | **One Docker image (Node + LibreOffice) on Fly.io**, always-on small machine | LibreOffice rules out Vercel serverless; always-on means no cold start when the grader clicks |
| Jobs | DB-backed job table + in-process worker loop (reminders, expiry, webhook retries) | No extra infra; idempotent and retried |
| Tests | Vitest (unit, detector corpus) + Playwright (E2E against local and deployed) | The deployed E2E run is the proof it works |

### Data model (core tables, all scoped by `workspace_id` with RLS)
- `workspaces` (name, slug, brand color, logo, sender name, reminder policy, expiry days)
- `members` (user, workspace, role: owner/admin/staff)
- `templates` (name, active version)
- `template_versions` (source file, normalized PDF, sha256, page count, field schema JSON, status: draft/published). **Published versions are immutable.** Files pin the version they were sent with.
- `fields` (in the schema JSON: type `signature|initials|name|date|text|checkbox`, role `client|firm|prefill`, page, x/y/w/h, label, required, prefill key)
- `files` (external ref, title, client name, client email, prefill values, template_version_id, status, token hash, expires_at)
- `signatures` (file, role, image, method drawn/typed, signed_at, ip, ua)
- `documents` (file, kind original/client_signed/final, storage path, sha256)
- `audit_events` (append-only; insert-only grants, no update/delete)
- `api_keys` (hashed), `webhook_endpoints` (url, secret, events), `webhook_deliveries`, `jobs`

## 4. The core problem: an agreement we have never seen

The grader's MIND agreement is the test, so this part gets the most time.

**Pipeline:** upload (PDF/DOCX, max 20 MB) → DOCX converted to PDF → pdf.js pulls every text item with coordinates → **field detector** → proposed fields drawn over the page → admin confirms or fixes in the **field editor** → publish.

**Detector (deterministic, no LLM, explainable):**
1. **Signature blocks.** Anchor phrases (`Signature`, `Signed`, `By:`, `Sign here`, `Authorized Signature`, `/s/`), underscore runs (`____`), and drawn horizontal lines from the PDF operator list near those anchors.
2. **Companion fields** in the same block: `Name` / `Printed Name` / `Print Name`, `Title`, `Date`, `Company`, `Email`, `Initials`.
3. **Party assignment.** Look for party headings above each block (`CLIENT`, `Customer`, `Company`, the firm's own name from workspace settings, `Provider`, `Consultant`). A block that names the firm → `firm` role, otherwise → `client`. Ambiguous → `client`, flagged for review.
4. **Inline blanks** in the body (`Client Name: ______`, `Effective Date: ______`, `dated ______`) → `prefill` fields mapped to file data (`client.name`, `today`, a custom key).
5. **Fallbacks.** No signature found → put a client signature box at the end of the last page and **block publishing until a human confirms it**. Scanned PDF with no text layer → say so plainly and open the manual editor (OCR is out of scope).
6. Every proposal carries a **confidence and a reason** ("matched 'By:' + underline, under heading 'CLIENT'"), shown in the editor.

**Editor:** drag, resize, retype, reassign role, add or delete fields, preview as the client. Publish is blocked unless there is at least one client signature and every prefill key maps to something.

**Test corpus (built Day 2, kept in `fixtures/agreements/`):** 12+ fake agreements made specifically to break the detector: single and multi-page, two-column signature tables, signature on its own last page, DOCX with tables, "By: ____ Name: ____ Title: ____" stacks, initials on every page, a scanned (image-only) PDF, no signature line at all, a non-English heading, and a long MSA with an exhibit. Each has an expected-fields JSON, and the detector's precision/recall over the corpus is a CI number that has to stay above the bar.

**Optional LLM assist (off by default, needs Param's OK on spend):** send the extracted text, never the file, to label ambiguous fields. The product has to score fully without it.

## 5. Legal and trust features (what makes it buyable)

- **ESIGN/UETA consent** screen before signing (records disclosure, a way to withdraw, a paper-copy option), and the consent is logged.
- **Intent to sign:** an explicit "Sign and complete" action, with the legal text shown next to the button.
- **Signer identity:** a single-use, expiring, hashed link sent to the client's email. Optional 6-digit email code before signing (on by default).
- **Tamper evidence:** SHA-256 of the original, client-signed and final PDFs. A **Certificate of Completion** page is appended (parties, emails, IPs, timestamps, hashes, event log). A public **/verify** page: drop in a PDF and it says whether it matches a completed record.
- **Firm countersign without a human:** the firm's signer adopts a signature once, and it's applied automatically right after the client signs (configurable: auto or manual review first).
- **Retention:** final PDFs in a private bucket, downloaded only through short-lived signed URLs. Audit rows can't be changed.
- **Security basics:** RLS on every table, rate limits on signing and auth endpoints, signed webhooks (HMAC), API keys stored as hashes, no PII in logs.

## 6. Automation and integrations ("on every file")

- **REST API:** `POST /api/v1/files` (client name, email, prefill, external_ref) → creates and sends in one call. `GET /api/v1/files/:id`, `GET /api/v1/files/:id/document`.
- **Outbound webhooks:** `file.sent`, `file.viewed`, `file.signed`, `file.completed`, `file.declined`, `file.expired`. HMAC-signed and retried with backoff.
- **Inbound webhook URL** per workspace, so a CRM or n8n can create files without writing API code.
- **n8n example workflow** (`integrations/n8n/`): "new deal in CRM → create file → on completed, move the deal stage". Astra runs on n8n, so this shows it slots into their stack on day one.
- **CSV import** for a backlog of files.
- **Reminders** (e.g. day 2 and day 5) and **expiry** (e.g. 14 days) per workspace, run by the job worker.

## 7. Features IN vs deliberately OUT

**IN** (each one is on the grader path or is what makes it sellable):
self-serve signup + workspaces · any PDF/DOCX upload · automatic field detection + editor · template versioning · file creation via UI/API/webhook/CSV · prefill · branded emails · mobile signing (draw/type) · ESIGN consent + email code · automatic firm countersign · certificate of completion + hashes + /verify · command center (status, filters, resend, remind, void, decline reasons, audit timeline) · reminders + expiry · webhooks + API keys · n8n example · team members with roles · branding.

**OUT** (and the reason, for the submission write-up):
| Left out | Why |
|---|---|
| Billing / Stripe | A pilot customer doesn't need checkout, and it adds nothing to "get the agreement signed". The pricing model is written in the README instead |
| Multiple client signers / signing order | One agreement per client per file is what was asked. The data model allows N signers later |
| Editing agreement text in-app | Legal text is the firm's. Changing it in our tool creates liability. Re-upload makes a new version |
| OCR for scanned PDFs | Big dependency for an edge case. Detected and routed to manual placement |
| PKI / PAdES certificate signatures, eIDAS QES | Needs a CA-issued cert and per-region legal work. ESIGN/UETA + audit trail is the U.S. market norm |
| SMS / KBA identity checks | Email possession + code is the industry baseline. SMS adds a vendor and cost |
| SSO/SAML, SOC 2 artifacts | Enterprise-sales features, not needed to buy and run it at firm size |
| Payments / retainers at signing | A separate product decision. Easy to add later |
| Native mobile app | The signing page is responsive, and clients never install anything |
| LLM-dependent detection | It has to work offline from LLMs, be deterministic, and cost nothing per file. LLM assist is optional |

## 8. Seven-day schedule

Deploy on Day 1 and keep the deployed app working every day after. Small commits, short messages, **no co-author trailers** (see `CLAUDE.md`).

| Day | Scope | Done when |
|---|---|---|
| **1** | Scaffold Next.js + Supabase, schema + RLS migrations, auth + workspace creation, upload to storage, DOCX→PDF in Docker, pdf.js page rendering, **first Fly.io deploy** | Can sign up and see an uploaded DOCX rendered as PDF pages on the live URL |
| **2** | Field detector + 12-agreement fixture corpus + precision/recall test; field editor (drag/resize/role/type); publish a template version | Detector scores above the bar on the corpus; a template can be published |
| **3** | Create a file → secure link → signing page (consent, email code, fill, draw/type sign) → pdf-lib stamping → automatic firm countersign → certificate page → hashes | **Full grader path works on the live URL** (link copied by hand, no email yet) + Playwright E2E #1 |
| **4** | Resend emails (send, reminder, completed, with attachment), job worker (reminders, expiry, webhook retries), command center dashboard + audit timeline, resend/void/decline | A file goes from creation to completed with zero manual clicks on the firm side |
| **5** | API + API keys, outbound/inbound webhooks, n8n workflow JSON, CSV import, branding, team invites, /verify page | n8n example creates a file and reacts to completion |
| **6** | Hardening: run 5 new unseen agreements through the deployed URL, mobile pass, rate limits, security review, error and empty states, loading states | Playwright E2E passes against prod on all fixtures; no console errors |
| **7** | README + submission description (built / in / out / why / tools used), demo walkthrough video (optional), seeded demo workspace, add `theastraway` as collaborator or make public, **final commit ≥12h before deadline** | Submission saved; commit history ends before the clock |

Buffer: Days 6–7 absorb slips. If Day 3 slips, cut from Day 5 (CSV, branding, /verify) first, and never from the grader path.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The MIND agreement layout fools the detector | Hostile fixture corpus, plus the editor so a human can fix it in seconds, plus publishing blocked without a client signature |
| The grader's email gets spam-filtered or delayed | The firm UI always shows **"Copy signing link"**; send from a verified domain if one is available |
| Cold start or crash during grading | Always-on Fly machine, health check, daily E2E against prod |
| DOCX renders differently from Word | LibreOffice with common fonts bundled; the admin previews the PDF before publishing |
| Running out of time | The grader path is done on Day 3; everything after that is additive |

## 10. Submission checklist
- [ ] Live URL works from a clean browser, with a new account
- [ ] Public repo (or `theastraway` added as collaborator)
- [ ] Description: what was built, features in + why, features out + why, assumptions, tools used (Next.js, Supabase, pdf.js, pdf-lib, LibreOffice, Resend, Fly.io, Playwright, Claude Code)
- [ ] Test data only in repo, seeds and screenshots
- [ ] No commit after the deadline

## 11. Open decisions for Param
1. **Exact deadline** (the countdown on the Astra page) → fixes the freeze time.
2. **Hosting accounts:** Fly.io (needs a card; ~$2–5 for the week), Supabase project, Resend account (+ a domain to send from, if he has one).
3. **LLM assist on/off** (paid calls need his OK; the default plan works without it).
4. **Product name** and repo visibility (public vs collaborator only).

## What changed while building (2026-11-05)

Sections 1–9 above are the original plan, kept as written. What actually shipped is described in `docs/SUBMISSION.md`. The differences:

- **Storage:** Supabase was replaced by SQLite (`node:sqlite`) plus files on a volume, with password auth and password reset (no magic links). One container with no external services means fewer ways for the grader's run to fail. Tenancy is enforced in every query by `workspace_id` rather than by RLS. Documents are served only through authenticated or token-checked routes, not signed bucket URLs.
- **Schedule:** built and deployed on day 1. The rest of the time went to detector accuracy on unseen agreements and hardening (an independent security review, then a second audit).
- **Accuracy:** detector accuracy was measured on held-out sets written by agents that couldn't read the detector (see `docs/SUBMISSION.md`). The test enforces a recall floor per corpus; there's no CI pipeline. E2E runs locally, against the Docker image, and against the live URL.
- **Email code:** **off** by default (the plan said on), and it can only be turned on when an email provider is configured, since otherwise the client could never receive the code.
- **Naming and schema:** the event is `file.completed` (not `file.agreement_completed`) and the state is `signed` (not `signed_by_client`). The n8n template lives at `public/integrations/n8n-countersign.json`. Signatures, reminders and webhook retries live on `files` and `webhook_deliveries` rather than separate `signatures` and `jobs` tables.

## Status
- [x] Plan written, repo initialized (2026-11-05)
- [x] Grader path end to end (browser E2E on all tuning fixtures, incl. Word via LibreOffice in Docker)
- [x] Detector measured on held-out + final sets
- [x] API, inbound webhook, outbound webhooks, n8n template, CSV import/export, reminders/expiry, team, password reset
- [x] Deployed to Fly.io: https://countersign-app.fly.dev (live E2E passing)
- [ ] Resend domain for real email
- [x] Private repo + `theastraway` collaborator invited
