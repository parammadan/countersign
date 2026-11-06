import { requireAdmin } from "@/lib/auth";
import { fmtDay } from "@/lib/time";
import { all } from "@/lib/db";
import { getWorkspace } from "@/lib/files";
import { appUrl } from "@/lib/paths";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { rotateInboundAction } from "@/app/actions";
import { Button, Card, PageHeader, cx } from "@/components/ui";
import { CopyButton } from "@/components/FileActions";
import { DeleteWebhook, NewKeyForm, NewWebhookForm, RevokeKey } from "@/components/DevForms";

export const metadata = { title: "Integrations & API" };

function Code({ children }: { children: string }) {
  return <pre tabIndex={0} className="overflow-x-auto rounded-lg bg-[#0f1729] p-4 text-[12.5px] leading-relaxed text-slate-100"><code>{children}</code></pre>;
}

export default async function Page() {
  const s = await requireAdmin();
  const ws = getWorkspace(s.workspaceId);
  const base = appUrl();
  const inbound = `${base}/api/inbound/${ws.inbound_token}`;
  const keys = all<{ id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC", ws.id);
  const hooks = all<{ id: string; url: string; events: string; created_at: string }>("SELECT * FROM webhooks WHERE workspace_id = ? AND active = 1 ORDER BY created_at DESC", ws.id);
  const agreements = all<{ id: string; name: string; is_default: number; live: number }>(
    "SELECT id, name, is_default, active_version_id IS NOT NULL AS live FROM templates WHERE workspace_id = ? AND archived = 0 ORDER BY is_default DESC, created_at",
    ws.id,
  );
  const deliveries = all<{ id: string; event: string; status: string; attempts: number; response_code: number | null; last_error: string | null; created_at: string; url: string }>(
    "SELECT d.*, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.workspace_id = ? ORDER BY d.created_at DESC LIMIT 15",
    ws.id,
  );
  return (
    <>
      <PageHeader title="Integrations & API" sub="Open files from your CRM, case system or n8n so the agreement goes out with no one touching it." />
      <div className="space-y-6">
        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">1. No-code: inbound webhook</h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            Point your CRM&apos;s &ldquo;new deal / new matter&rdquo; automation, a Zapier zap or an n8n HTTP node at this URL. Each POST opens a file and emails the agreement. Accepts JSON or form posts with <code>client_name</code>/<code>name</code>, <code>client_email</code>/<code>email</code>, and optional <code>company</code>, <code>ref</code>, <code>title</code>. <code>prefill</code> (the agreement&apos;s blanks) needs JSON. A repeated <code>ref</code> is rejected, so retries never double-send.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-gray-50 px-3 py-2 font-mono text-xs">{inbound}</code>
            <div className="flex gap-2">
              <CopyButton text={inbound} />
              <form action={rotateInboundAction}><Button variant="ghost">Rotate</Button></form>
            </div>
          </div>
          <div className="mt-4">
            <Code>{`curl -X POST ${inbound} \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"Jordan Sample","client_email":"jordan@example.com","ref":"2026-0142"}'`}</Code>
          </div>
          <p className="mt-3 text-sm">
            <a className="font-medium text-brand" href="/integrations/n8n-countersign.json" download>Download the n8n workflow</a>
            <span className="text-muted">: &ldquo;new CRM record → send agreement → when signed, update the CRM; if declined, alert Slack&rdquo;.</span>
          </p>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">2. REST API</h2>
          <p className="mt-1 mb-4 text-sm text-muted">Bearer-token API for your own systems. Keys are shown once and stored only as a hash.</p>
          <NewKeyForm />
          {keys.length > 0 && (
            <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
              {keys.map((k) => (
                <li key={k.id} className={cx("flex items-center justify-between gap-3 px-4 py-2.5", k.revoked_at && "text-muted line-through")}>
                  <span className="min-w-0 truncate">{k.name} <code className="ml-2 text-xs text-muted">{k.prefix}…</code></span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted">
                    {k.last_used_at ? `used ${fmtDay(k.last_used_at)}` : "never used"}
                    {!k.revoked_at && <RevokeKey id={k.id} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {agreements.length > 0 && (
            <div className="mt-5 overflow-x-auto rounded-lg border border-line text-sm">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2">Agreement</th>
                    <th className="px-4 py-2"><code>agreement_id</code></th>
                  </tr>
                </thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">{a.name}{a.is_default ? <span className="ml-2 text-xs text-muted">(default: used when no agreement_id is sent)</span> : null}{!a.live ? <span className="ml-2 text-xs text-warn">not published</span> : null}</td>
                      <td className="px-4 py-2"><code className="text-xs">{a.id}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-5 space-y-3 text-sm">
            <Code>{`# Open a file and send the agreement
curl -X POST ${base}/api/v1/files \\
  -H "Authorization: Bearer cs_live_..." -H "Content-Type: application/json" \\
  -d '{"client_name":"Jordan Sample","client_email":"jordan@example.com",
       "ref":"2026-0142","prefill":{"fee":"4,500"}${agreements.length > 1 ? `,
       "agreement_id":"${agreements[0].id}"` : ""}}'

# Check status / list / fetch the signed PDF
curl ${base}/api/v1/files/{id}        -H "Authorization: Bearer cs_live_..."
curl "${base}/api/v1/files?status=completed" -H "Authorization: Bearer cs_live_..."
curl ${base}/api/v1/files/{id}/document -o signed.pdf -H "Authorization: Bearer cs_live_..."

# Agreements and the blanks they expect in "prefill"
curl ${base}/api/v1/agreements -H "Authorization: Bearer cs_live_..."

# Nudge or cancel
curl -X POST ${base}/api/v1/files/{id}/remind -H "Authorization: Bearer cs_live_..."
curl -X POST ${base}/api/v1/files/{id}/void   -H "Authorization: Bearer cs_live_..." -d '{"reason":"duplicate"}'`}</Code>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold">3. Webhooks out</h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            We POST JSON when a file changes. Each request carries <code>X-Countersign-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code>{"{t}.{body}"}</code> with your signing secret. Failed deliveries retry for about 15 hours (1m, 5m, 30m, 2h, 12h).
          </p>
          <NewWebhookForm events={WEBHOOK_EVENTS} />
          {hooks.length > 0 && (
            <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
              {hooks.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate">{h.url} <span className="ml-2 text-xs text-muted">{h.events === "*" ? "all events" : h.events.replace(/,/g, ", ")}</span></span>
                  <DeleteWebhook id={h.id} />
                </li>
              ))}
            </ul>
          )}
          {deliveries.length > 0 && (
            <>
              <h3 className="mt-5 mb-2 text-sm font-semibold">Recent deliveries</h3>
              <ul className="divide-y divide-line rounded-lg border border-line text-xs">
                {deliveries.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 truncate"><code>{d.event}</code> → {d.url}</span>
                    <span className={cx("shrink-0", d.status === "delivered" ? "text-ok" : d.status === "dead" ? "text-bad" : "text-warn")}>
                      {d.status}{d.response_code ? ` (${d.response_code})` : ""}{d.attempts > 1 ? ` · ${d.attempts} tries` : ""}{d.last_error && d.status !== "delivered" ? ` · ${d.last_error}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
