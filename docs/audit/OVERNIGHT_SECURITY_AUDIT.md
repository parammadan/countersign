# Overnight security audit

Date: 2026-11-11. Base: `main` at `cdc3aa3`. Read-only review of the code; nothing was run against production, no code was changed.
Scope: `app/api/**`, `app/*actions*.ts`, rate limits, token handling, uploads, AI gating, prompt-injection handling, SQL, `dangerouslySetInnerHTML`.

Summary: no high-severity findings. 3 medium, 7 low. The trust core (signing, sealing, workspace scoping, role checks, AI spend gate) held up.

## Findings

### M1 (medium) Rate limits collapse to one shared bucket when `TRUST_PROXY` is unset
`lib/ratelimit.ts:17-22` (`clientIp`) returns `"unknown"` unless `TRUST_PROXY` is `fly`, `1` or `true`. Every limiter (`rateLimit` in `lib/http.ts:36`, `throttle` in `app/actions.ts:35`, `/api/sign/[token]/status`) keys on that IP.
Scenario: if a deploy (a new environment, a restart with a missing env var) lacks `TRUST_PROXY`, all visitors share one bucket per route. One client sending 10 requests a minute to `/api/sign/*/otp` or `loginAction` locks every real signer and user out of that route. It also puts `ip: "unknown"` in the audit trail.
Fix: fail closed at boot in production (refuse to start or log loudly when `NODE_ENV=production` and `TRUST_PROXY` is unset), and add a startup check next to the `APP_URL` warning in `lib/paths.ts:11`.

### M2 (medium) Bulk and repeat email sending has no per-user or per-workspace limit
`app/actions.ts:185` (`createFileAction`), `app/actions.ts:521` (`importCsvAction`, up to 200 sends per call), `app/actions.ts:600` (`testFileAction`) and `app/api/inbound/[token]/route.ts:11` (60/min per IP) all create and send agreement emails. They are open to any role including `staff`, and only the 1-minute same-file resend guard exists (`app/actions.ts:211`).
Scenario: a compromised or malicious staff account (or anyone holding the inbound URL) loops `importCsvAction` with 200 recipients each, and the firm's sender domain is used to mail arbitrary addresses with attacker-chosen client names and refs. Reputation damage and possible provider suspension.
Fix: a per-workspace daily send cap (count `emails` rows with kind `invite`, as the AI gate does for spend), a per-user limit on `importCsvAction`, and consider admin-only for CSV import.

### M3 (medium) Inbound webhook token is stored in plaintext and is a bearer credential in the URL
`lib/db.ts:30` (`workspaces.inbound_token`), looked up directly at `app/api/inbound/[token]/route.ts:14`; shown in `app/app/developers/page.tsx:19`. Every other credential (sessions, API keys, signing links, invites, resets) stores only a hash, so this is the one exception.
Scenario: a database or backup leak exposes working inbound URLs for every workspace, and anyone with one can create and send agreements as that firm. The token also appears in request paths in proxy and access logs.
Fix: store `sha256(token)` and look up by hash (show the token once on rotate, as API keys do); add `rotateInboundAction` confirmation; strip the path from request logging.

### L1 (low) Word uploads are accepted on file extension alone
`lib/convert.ts:20-26`: `.pdf` content is sniffed (`%PDF-`), but `.docx/.doc/.odt/.rtf` go to LibreOffice based on the filename. Size is capped (20 MB, `app/api/agreements/upload/route.ts`, `readCapped`) and concurrency is capped at 3, but there is no content check.
Scenario: an admin-role user uploads a crafted file named `x.docx` to exercise the LibreOffice parser (zip/XML bombs, exotic formats). The blast radius is the `soffice` subprocess.
Fix: sniff magic bytes (`PK\x03\x04` for docx/odt, `D0CF11E0` for doc, `{\rtf` for rtf), run `soffice` with a timeout, resource limits and no network, and cap decompressed size.

### L2 (low) Signing-room page `/s/[token]` has no rate limit
`app/s/[token]/page.tsx` calls `loadByToken` on every render with no limiter, and the "viewed" write sits behind the rate-limited `/viewed` route only. Tokens are 24 random bytes (`lib/util.ts:7`), so guessing is infeasible; the exposure is cheap unauthenticated DB reads and CPU.
Fix: a coarse per-IP limiter in the page (or edge/proxy), matching `/api/sign/[token]/status` (60/min).

### L3 (low) OTP: email bombing and offline guessing
`lib/files.ts:326-346` `sendOtp` has no per-file send cap; `/api/sign/[token]/otp` allows 5/min per IP only. Rotating IPs can flood the client's inbox with codes. The stored value is `sha256(fileId:code)` of a 6-digit code (`lib/files.ts:328`), so a leaked DB row is brute-forced instantly (guessing online is capped at 5 attempts, `lib/files.ts:353`).
Fix: cap OTP sends per file per hour; store an HMAC keyed with `APP_SECRET` instead of a bare hash.

### L4 (low) Login and reset throttles are per IP only
`app/actions.ts:101` (`loginAction`, 10/min/IP), `:497` (`resetAction`), `:66` (`signupAction`). No per-account counter, and the limiter is in-memory (resets on restart, not shared across instances).
Scenario: a distributed attacker tries passwords at 10/min per source against one account. scrypt cost slows it but there is no lockout or alert.
Fix: add a per-email bucket (for example 20 failures/hour) and audit failed logins.

### L5 (low) Account enumeration on signup
`app/actions.ts:70`: "An account with this email already exists." confirms registered addresses (login and forgot are generic). Throttled at 10/min/IP.
Fix: generic response plus an email to the existing owner, or accept the trade-off for UX.

### L6 (low) Staff role can export all client data and void files
`app/api/files/export/route.ts:7` (`sessionOr401` only; CSV of every client name, email, company), `voidFile` via `fileAction` (`app/actions.ts:246`), `importCsvAction`. Possibly by design, but the export is a bulk-PII action.
Fix: restrict export (and arguably CSV import) to admin+, and audit-log exports (there is no audit event for `/api/files/export`).

### L7 (low) Dead, ungated model entry point and in-memory AI hourly counters
`lib/understand/model.ts:133` `analyzeWithModel` calls a provider directly, bypassing `aiGate`/`metered`. Nothing calls it today (grep), but a future caller would skip the spend cap and verified-workspace rule. Separately, Studio's per-workspace hourly counters (`lib/drafts/service.ts:213-215, 427-431`, `recentSuggest`/`recentGenerate`) are in-memory and reset on restart; the daily spend cap in `ai_spend` still holds, so this is only a soft limit.
Fix: delete `analyzeWithModel` or make it take a gated provider type; optionally persist the hourly counts.

### Informational
- There are no `/scan/**` or `/api/scan/**` routes in this tree, and no `middleware.ts`/`proxy.ts`: every route authenticates itself. Confirm the scan feature is not expected here, and keep the "each route self-checks" convention tested (a route test that fails on any `app/api/**` route lacking `sessionOr401`/`apiAuth`/`rateLimit`).
- Webhook signing secrets (`lib/db.ts:156`) and sealed signing tokens (`files.token_enc`, `lib/files.ts:78`, reversible with `APP_SECRET`) are stored recoverably; both are by design (HMAC needs the secret; "copy link" needs the token). Their protection is `APP_SECRET`.
- Error handling: `handle()` (`lib/http.ts:16-26`) and `fail()` (`app/actions.ts:48-54`) log unknown errors with `console.error(e)`; an upstream error that echoes a URL could carry a signing token. `lib/understand/model.ts:113-128` correctly replaces provider errors with fixed text.

## Checked and found fine

**Authentication, workspace scope, roles (every route)**
- Session routes (`/api/agreements/*`, `/api/files/*`, `/api/settings/signature`, `/api/versions/[id]/*`) all call `sessionOr401` (cookie session plus same-origin CSRF check, `lib/http.ts:38-50`) and scope queries by `ws.id` (`getFile(ws.id, id)`, `getTemplateVersion(ws.id, id)`, `saveFields(ws.id, ...)`).
- Admin-only actions check `s.role === "staff"` -> 403: upload, fields PUT, publish, countersignature (`app/api/**`).
- `/api/v1/**` all call `apiAuth` (Bearer `cs_...`, key looked up by `sha256`, revoked keys refused, 120/min/IP, `lib/http.ts:62-78`) and scope by the key's workspace. No route takes a workspace id from the request.
- `/api/health` is public and returns only `{ok:true}`. `/api/verify` is public by design, rate-limited (20/min), streams with a 30 MB cap and returns only the match metadata.
- Server actions: every export in `app/actions.ts` and the six other action files starts with `requireSession`/`requireAdmin` (login/signup/forgot/reset/confirm/accept-invite are public by nature and call `throttle`). Workspace and role come from the session; services re-authorize (`lib/drafts/roles`, `lib/clauses/app/service.ts`, `lib/intake/service.ts`, `lib/m3/store.ts:122`).
- `memberAction` blocks self-change and non-owner changes to owners, and kills sessions on removal/role change. `loginAction` redirect is restricted to `/app...` paths (no open redirect).
- Next's built-in Origin check covers server actions; the JSON routes use `sameOrigin`.

**Rate limits on public endpoints**
- Every `/api/sign/[token]/*` route is limited (complete 10, decline 5, otp 5, verify 10, consent 20, viewed/download 30, pdf 60, status 60 per minute). `/api/inbound` 60, `/api/verify` 20. Auth actions: login 10, signup 10, forgot 5, reset 10, invite 10, verify-resend 3, confirm 20. (Caveats: M1, L2, L4.)

**Token handling**
- Sessions, signing links (`files.token_hash`, `lib/files.ts:301`), invites, password resets, email-verify tokens and API keys store only SHA-256 hashes; tokens are `crypto.randomBytes` (24 bytes, base64url). Session cookie is httpOnly, SameSite=Lax, Secure in production. Reset kills all sessions. Invite/reset links are withheld from the email log (`app/actions.ts:412`, `:482`). The signing status route and others avoid logging the URL. Comparison uses `timingSafeEqual`/`safeEqual`; login does equal work for unknown users (`DUMMY_HASH`). OTP has a 5-attempt cap enforced atomically in SQL.
- Only `console.error` sites found are listed above; none print a token, apart from the generic caveat under Informational.

**Uploads**
- Size caps with streaming enforcement that doesn't trust Content-Length (`lib/http.ts:76-94`): agreements 20 MB, inbound form 200 KB, JSON 2 MB, CSV 1 MB, intake 1.9 MB, signature PNG checked by magic bytes, IHDR and dimensions (`app/api/settings/signature/route.ts`). PDFs are sniffed, page-capped at 100, re-saved, form-flattened; encrypted PDFs refused. In-flight upload cap of 3. (Caveat: L1.)

**AI gating**
- Every model call path goes through `aiGate`/`metered` (`lib/ai/budget.ts`) or the Q&A reservation gate: Studio suggest (`lib/drafts/service.ts:209`), Studio draft (`:423`), Knowledge Hub (`lib/m3/store.ts:143`), Document Intelligence (`lib/intake/ai-service.ts:82`) and doc Q&A, including its verifier (`:156-162`), and agreement Q&A (`lib/qa/store.ts:100-120`: same daily, per-workspace and new-workspace caps, reserved in one transaction, verified-owner rule). `configuredProvider` is only used as an input to those gates. `analyzeVersion` (`lib/understand/store.ts`) is rules-only, no model. Provider errors are replaced with fixed text. Per-user/per-minute and per-workspace/day limits exist in each feature.

**Prompt injection**
- Documents go to the model as untrusted data in marked blocks with `<`/`>` neutralised so page markers can't be forged (`lib/understand/model.ts:93`); intake blanks quarantined lines before any model input (`lib/intake/ai-service.ts:10`); Knowledge Hub screens passages (`lib/m3/security/sanitize.ts`, `lib/m3/index/injection.ts`); Q&A drops instruction-like passages and withholds instruction-like answers (`lib/qa/answer.ts:418, 549`); Studio rejects instruction-like party names, terms and notes (`lib/m23/m23-generate/checks.ts`, `build.ts`) and checks output against the baseline. Injection-flagged intake records trigger no automated workflow action (`lib/workflow/m4-pipeline.ts:44`).

**SQL**
- All queries are parameterised. The only template-string SQL takes constants: `lib/drafts/store.ts:117` (every `move()` call passes a literal `SET` clause; `status IN` placeholders are generated), `lib/workflow/outbox.ts:490-497` (literal guard), `PRAGMA`/`ALTER TABLE` in migrations from fixed lists. `/api/v1/files` filters and limit are bound parameters.

**XSS**
- No `dangerouslySetInnerHTML`, `innerHTML` or `__html` anywhere in `app/`, `components/` or `lib/`. Email HTML escapes user strings with `escapeHtml`. CSV export neutralises formula injection (`lib/csv.ts:39`). Production CSP, `nosniff`, `X-Frame-Options: DENY`, HSTS set in `next.config.ts`.

**SSRF**
- Webhook URLs: https only, no credentials, hostname required, DNS pre-check, and a connect-time `lookup` that refuses private ranges (defeats rebinding), redirects not followed, 12 s timeout (`lib/ssrf.ts`).
