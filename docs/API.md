# Countersign API reference

For integrators: open a client file from your CRM, send the firm's agreement for signature, and find out
when it's signed and sealed. Three ways in:

| | Use it for | Auth |
|---|---|---|
| [Public API](#public-api-apiv1) `/api/v1/*` | Full control from your own code | API key |
| [Inbound webhook](#inbound-webhook) `/api/inbound/{token}` | No-code: a CRM, n8n or Zapier posts a new client | The secret URL |
| [Outbound webhooks](#outbound-webhooks) | Being told when a file is sent, viewed, signed, completed… | HMAC signature you verify |

The machine-readable spec is [`public/openapi.json`](../public/openapi.json) (OpenAPI 3.1, served by the
app at `/openapi.json`); `test/openapi.test.ts` fails if a route exists without an entry. A ready-made n8n
workflow is in [`public/integrations/n8n-countersign.json`](../public/integrations/n8n-countersign.json).

Everything is set up on **Integrations & API** (`/app/developers`) in the app, by a workspace admin.
In the examples, `https://app.example.com` stands for your deployment's URL.

## Conventions

- JSON in and out (`Content-Type: application/json`), except the PDF download. JSON bodies up to 2 MB.
- Timestamps are ISO 8601 in UTC, e.g. `2026-03-04T15:20:11.123Z`. Fields that haven't happened yet are `null`.
- Ids are prefixed strings: `file_…` for files, `wd_…` for webhook deliveries.
- Errors are `{"error": "<message>"}` with the status code:

| Status | When |
|---|---|
| 400 | Body isn't valid JSON (`Body must be JSON.`), or a form upload couldn't be read |
| 401 | Missing, malformed, unknown or revoked API key |
| 403 | The workspace owner hasn't confirmed their email yet (where the deployment requires it): until then agreements can only go to the firm's own team |
| 404 | File, agreement or inbound URL not found in this workspace |
| 409 | The action doesn't fit the file's state (see each endpoint) |
| 413 | Body too large |
| 422 | Validation failed: `field: message` items joined by `; `, e.g. `client_name: required; client_email: must be a valid email` |
| 429 | Rate limit, or the daily cap on new files |
| 500 | Unexpected error (`Something went wrong on our side. Please try again.`) |

**Limits.** API requests: 120 per minute per client IP address. Inbound webhook: 60 per minute per IP.
New files: 300 per workspace in any 24 hours by default (the deployment can change it); beyond that,
creating a file returns 429. When you hit 429, wait a minute and retry.

## Public API (`/api/v1`)

### Authentication

Create a key on Integrations & API. It is shown once; store it as a secret. Send it on every request:

```
Authorization: Bearer cs_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Revoking a key in the app makes it return 401 immediately. Actions taken with a key are recorded in each
file's audit trail as `API key "<key name>"`.

### The file object

Returned by every file endpoint and carried in every webhook event.

```json
{
  "id": "file_Q2x8…",
  "ref": "CRM-1042",
  "title": "Engagement Letter: Sample Client",
  "status": "sent",
  "client": { "name": "Sample Client", "email": "client@example.com", "company": "Example Co" },
  "prefill": { "fee": "4500" },
  "created_at": "2026-03-04T15:20:11.123Z",
  "sent_at": "2026-03-04T15:20:11.456Z",
  "viewed_at": null,
  "signed_at": null,
  "completed_at": null,
  "declined_at": null,
  "decline_reason": null,
  "expires_at": "2026-03-18T15:20:11.456Z",
  "ready_for_work": false,
  "email": { "status": "sent", "error": null, "copy_emailed_at": null },
  "signing_url": "https://app.example.com/s/<token>",
  "document_url": null,
  "app_url": "https://app.example.com/app/files/file_Q2x8…"
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The file id |
| `ref` | string \| null | Your reference (CRM id, matter number) |
| `title` | string | Defaults to `<agreement name>: <client name>` |
| `status` | string | See [Statuses](#statuses) |
| `client.name`, `client.email` | string | The signer. Email is lower-cased |
| `client.company` | string \| null | |
| `prefill` | object | Custom pre-fill values as stored (all strings) |
| `created_at` | timestamp | |
| `sent_at` | timestamp \| null | When the file was last sent from `draft`, `expired` or `declined` (the first invitation, or sending a closed file again). Not changed by reminders or by resending a file that is still open |
| `viewed_at` | timestamp \| null | When the client first opened the link |
| `signed_at` | timestamp \| null | When the client signed |
| `completed_at` | timestamp \| null | When the firm countersigned and the PDF was sealed |
| `declined_at`, `decline_reason` | timestamp \| null, string \| null | If the client declined, and their reason |
| `expires_at` | timestamp \| null | When the signing link expires if still unsigned. Set on sending, and pushed back by a resend from the app (not by reminders) |
| `ready_for_work` | boolean | `status == "completed"`. In `GET /api/v1/files/{id}` it is the full [readiness check](#get-apiv1filesid) instead |
| `email.status` | `sent` \| `failed` \| `logged` \| null | The last invitation or reminder email: delivered to the mail server; failed (reason in `email.error`); recorded in the app's email log without going to a mail server (e.g. none configured); or never sent |
| `email.error` | string \| null | Why the email failed |
| `email.copy_emailed_at` | timestamp \| null | When the client was emailed their signed copy |
| `signing_url` | string \| null | The client's private signing link. `null` once voided. **Treat it as a secret**: whoever has it can sign |
| `document_url` | string \| null | The sealed PDF ([download](#get-apiv1filesiddocument), needs the key) once completed, else `null` |
| `app_url` | string | The file in the app, for staff |

### Statuses

| Status | Meaning | Next |
|---|---|---|
| `draft` | Created with `send: false`; not emailed | sent (from the app), voided |
| `sent` | Signing link emailed | viewed, declined, expired, voided |
| `viewed` | The client opened the link | signed, declined, expired, voided |
| `signed` | The client signed; waiting for the firm's countersignature | completed, voided |
| `completed` | Countersigned and sealed. The PDF can be downloaded | final |
| `declined` | The client declined (`decline_reason`) | sent again from the app (no event), voided |
| `expired` | The link passed `expires_at` unsigned | sent again from the app (no event), voided |
| `voided` | Cancelled by the firm; the link no longer works | final |

### `GET /api/v1/agreements`

The workspace's agreements (not archived), oldest first. Use an `id` as `agreement_id` when creating a
file, and `prefill_fields` to know which `prefill` keys that agreement takes.

```bash
curl https://app.example.com/api/v1/agreements -H "Authorization: Bearer $COUNTERSIGN_KEY"
```

```json
{
  "data": [
    {
      "id": "tpl_…",
      "name": "Engagement Letter",
      "default": true,
      "published_version": 3,
      "published_at": "2026-02-01T10:00:00.000Z",
      "prefill_fields": [{ "key": "fee", "label": "Fixed fee" }]
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Pass as `agreement_id` |
| `name` | string | |
| `default` | boolean | Used when a new file names no agreement |
| `published_version` | integer \| null | The active published version; `null` if never published (files can't use it yet) |
| `published_at` | timestamp \| null | |
| `prefill_fields[]` | `{key, label}` | Custom pre-fill fields on the published version. `key` is without the `custom.` prefix |

### `POST /api/v1/files`

Open a file for one client and, by default, email them the signing link. Responds **201** with the
[file](#the-file-object).

```bash
curl https://app.example.com/api/v1/files \
  -H "Authorization: Bearer $COUNTERSIGN_KEY" -H "Content-Type: application/json" \
  -d '{"client_name":"Sample Client","client_email":"client@example.com","ref":"CRM-1042","prefill":{"fee":"4500"}}'
```

Body. The field names accept common CRM aliases, so a raw CRM record can often be posted as is. Where
both names are sent, the first one in the table wins. Strings are trimmed; unknown fields are ignored.

| Field | Alias | Type | Notes |
|---|---|---|---|
| `client_name` | `name` | string, ≤ 200 | **Required** |
| `client_email` | `email` | string, ≤ 320 | **Required**, must look like an email. Lower-cased |
| `client_company` | `company` | string, ≤ 200 | |
| `ref` | `external_ref` | string or number, ≤ 120 | Numbers become strings. Must be unique among files that aren't voided or declined |
| `agreement_id` | `template_id` | string, ≤ 60 | Omit to use the default agreement (or the newest published one) |
| `title` | | string, ≤ 200 | Defaults to `<agreement name>: <client name>` |
| `prefill` | | object | `{ "<key>": string \| number \| boolean }`, keys ≤ 60, values ≤ 2000 characters. Keys from `prefill_fields`; a `custom.` prefix is accepted and stripped. Values are stored as strings; a checkbox field is ticked by `1`, `true`, `yes` or `x` |
| `send` | | boolean | Default `true`. `false` creates a `draft` without emailing anyone |

With `send` on, the file is `sent` even if the email fails: the response is still 201, `email.status` is
`failed` with the reason, and no `file.sent` event is emitted. You can hand the client `signing_url` yourself.

Errors: 403 (email not confirmed), 404 (`agreement_id` not found), 409 (no published agreement, the chosen
agreement has no published version, or the `ref` is taken), 422 (validation), 429 (rate limit or daily cap).

Events: `file.created`, then `file.sent` if sent and the email didn't fail.

### `GET /api/v1/files`

Newest first: `{"data": [file, …]}`.

| Query | Notes |
|---|---|
| `status` | One of the [statuses](#statuses); exact match (an unknown value matches nothing) |
| `ref` | Your reference; exact match |
| `limit` | 1–100, default 50 |

There is no cursor: to find a specific file, filter by `ref`. `ready_for_work` in the list is
`status == "completed"`.

```bash
curl "https://app.example.com/api/v1/files?ref=CRM-1042" -H "Authorization: Bearer $COUNTERSIGN_KEY"
```

### `GET /api/v1/files/{id}`

One file, plus a fresh **readiness** check: `ready_for_work` is true only when the file is `completed`
and every required check passes, including that the sealed PDF in storage still matches the SHA-256
recorded when it was sealed. Use this before starting work on a client.

```json
{
  "id": "file_…",
  "status": "completed",
  "ready_for_work": true,
  "readiness": [
    { "key": "consent", "label": "Client consented to sign electronically", "ok": true, "required": true },
    { "key": "client_signed", "label": "Client signed every required field", "ok": true, "required": true },
    { "key": "countersigned", "label": "Your firm's countersignature applied", "ok": true, "required": true },
    { "key": "sealed", "label": "Final PDF sealed and intact", "ok": true, "required": true, "detail": "SHA-256 3f9a1c0b7e2d… matches" },
    { "key": "not_voided", "label": "File is still active (not voided)", "ok": true, "required": true },
    { "key": "copy_emailed", "label": "Client emailed their signed copy", "ok": true, "required": false }
  ]
}
```

(other file fields omitted). `readiness[]` items are `{key, label, ok, required, detail?}`; the keys are
`consent`, `client_signed`, `countersigned`, `sealed`, `not_voided` and `copy_emailed` (informational,
not required). Errors: 404.

### `GET /api/v1/files/{id}/document`

The sealed PDF with its audit certificate, as `application/pdf`, with
`Content-Disposition: attachment; filename="<title> - signed.pdf"` and `X-Content-SHA256: <hex>`, the
fingerprint recorded at sealing (also `data.sha256` in the `file.completed` event). Check it after download.

`<title>` is the file's title cleaned for use as a filename: characters other than letters `A–Z`/`a–z`,
digits, space, `_`, `.` and `-` are removed, runs of spaces become one, the result is trimmed and cut to 80
characters, and `agreement` is used if nothing is left. So `Smith & Co: Retainer (2026)` downloads as
`Smith Co Retainer 2026 - signed.pdf`. Don't rely on the filename to identify the file; use its `id`.

```bash
curl -OJ https://app.example.com/api/v1/files/file_…/document -H "Authorization: Bearer $COUNTERSIGN_KEY"
```

Errors: 404, 409 (`Not completed yet.`).

### `POST /api/v1/files/{id}/remind`

Email the client a reminder with the same link. No body. Only for `sent` or `viewed` files (otherwise 409).
It doesn't change `expires_at` and emits no event. Returns the file; check `email.status`. Errors: 403, 404, 409.

### `POST /api/v1/files/{id}/void`

Cancel a file. Optional body `{"reason": "…"}`, kept in the audit trail (first 500 characters) and not
returned. Allowed in any status except `completed` and `voided`; also 409 if the file is being countersigned
at that moment (retry shortly). Returns the file with `status: "voided"` and `signing_url: null`. Emits `file.voided`.

## Inbound webhook

`POST /api/inbound/{token}`: the no-code way in. Copy the URL from Integrations & API; the token in it is
the only credential, so keep the whole URL secret. **Rotating** it in the app makes the old URL return 404.

- Same body and behaviour as [`POST /api/v1/files`](#post-apiv1files), same 201 response and events. The
  audit trail records the source as `inbound webhook`.
- Accepts JSON, or `application/x-www-form-urlencoded` / `multipart/form-data` (up to 200 KB; only text
  fields are read, files ignored). In a form body every value is a string, so send `prefill` and `send`
  only as JSON: as form fields they fail validation (422).
- 60 requests per minute per IP. Unknown token: 404 `Unknown inbound URL.`

```bash
curl https://app.example.com/api/inbound/<token> \
  -H "Content-Type: application/json" \
  -d '{"name":"Sample Client","email":"client@example.com","company":"Example Co","external_ref":1042}'
```

**n8n.** Import `public/integrations/n8n-countersign.json`: a Webhook node for your CRM, an HTTP Request
node that maps the CRM record to `client_name`, `client_email`, `company`, `ref`, `title` and posts it to
your inbound URL, and a second Webhook node to receive Countersign's events. Paste the inbound URL into the
HTTP Request node, and that second node's production URL into Webhooks out in the app.

## Outbound webhooks

Add an endpoint URL on Integrations & API and choose its events (none chosen means all). The app shows a
**signing secret** (`cswh_…`) once. The URL must be publicly reachable (private and internal addresses are refused).

### Events

| Event | When |
|---|---|
| `file.created` | A file was created (any source: app, API, inbound, CSV) |
| `file.sent` | The first invitation email went out (or was logged). Not emitted when that email failed, and not emitted again when a declined or expired file is sent again from the app (see below) |
| `file.viewed` | The client first opened the link |
| `file.signed` | The client signed |
| `file.completed` | The firm countersigned and the PDF was sealed. `data.sha256` is the PDF's SHA-256 |
| `file.declined` | The client declined (`data.decline_reason`) |
| `file.expired` | The link passed `expires_at` unsigned |
| `file.voided` | The firm voided the file |

### Request

`POST` to your URL with:

```
Content-Type: application/json
User-Agent: Countersign-Webhooks/1.0
X-Countersign-Event: file.completed
X-Countersign-Delivery: wd_…
X-Countersign-Signature: t=1772637611,v1=5d0c…(64 hex)
```

```json
{
  "id": "wd_…",
  "event": "file.completed",
  "created_at": "2026-03-05T09:12:44.001Z",
  "data": { "...the file object...": "", "sha256": "3f9a…" }
}
```

`data` is the [file object](#the-file-object) as it was when the event happened, with one exception: for
`file.sent`, `data` is read after the file moves to `sent` but before the invitation's email status is
recorded, so `data.email.status` and `data.email.error` still show their previous values (`null` for a
file's first invitation). Read the file with `GET /api/v1/files/{id}` if you need the delivery status.

Sending a declined or expired file again from the app ("Send again", "Reopen and resend") returns it to
`sent` with a new `sent_at` and `expires_at`, but emits **no** event: `file.sent` fires only for the first
invitation, and resends and reminders emit nothing. If you track status from events alone, a file you saw
as `file.declined` or `file.expired` may be open again; poll `GET /api/v1/files/{id}` to catch this.

`id` equals
`X-Countersign-Delivery`: one per endpoint per event, unchanged across retries. `created_at` is when the
event happened, not when this attempt was sent. Note that `data.signing_url` is the client's live link:
store event payloads as carefully as the link itself.

### Verifying the signature

`v1` is the hex HMAC-SHA256, keyed with your signing secret, of `<t>.<raw request body>` (the `t` value,
a dot, then the body bytes exactly as received; don't re-serialise the JSON). `t` is Unix seconds and is
set per attempt, so you can reject old timestamps (e.g. more than 5 minutes) to stop replays.

```js
import crypto from "node:crypto";

function verify(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const ok = parts.v1?.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  return ok && Math.abs(Date.now() / 1000 - Number(parts.t)) <= toleranceSec;
}
```

In n8n, do this in a Code node before acting on the event (the webhook node must pass the raw body).

### Responses and retries

Answer with any **2xx** status as soon as you've stored the event. Anything else (another status, a
connection error, a timeout) counts as a failure. Each attempt allows 10 seconds to connect and 10 seconds
for your response headers (and 10 seconds between body chunks), within an overall limit of **12 seconds**
for the attempt; only the status code is used, not your response body. **Redirects are not followed**: a
3xx response counts as a failed attempt (recorded as `HTTP 301` and so on), so give the final URL when you
add the webhook. The first attempt is made immediately. Failed
deliveries are retried after **1, 5, 30, 120 and 720 minutes** (the background worker checks every minute,
so a retry can be up to a minute late): six attempts in all over about 14½ hours, after which the delivery is
marked dead. Removing the webhook in the app stops pending retries. The Integrations & API page shows each
delivery's status, attempts, last response code and error.

Delivery is **at least once** and **not ordered**: an attempt interrupted by a restart is retried, so the
same delivery can arrive twice, and a retried `file.viewed` can arrive after `file.signed`. De-duplicate on
`X-Countersign-Delivery`, and if you need the current state, read it with `GET /api/v1/files/{id}`.

## Typical flow

1. `GET /api/v1/agreements` once, to pick an `agreement_id` and see its `prefill_fields`.
2. On a new client in your CRM: `POST /api/v1/files` (or the inbound webhook) with your `ref`.
3. Subscribe to `file.completed` and `file.declined` (and `file.expired`, if you chase clients yourself).
4. On `file.completed`: `GET /api/v1/files/{id}` and start work only if `ready_for_work` is true; download
   the PDF from `document_url` and check its SHA-256.
