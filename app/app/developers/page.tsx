import { requireAdmin } from "@/lib/auth";
import { fmtDay } from "@/lib/time";
import { all } from "@/lib/db";
import { getWorkspace } from "@/lib/files";
import { appUrl } from "@/lib/paths";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { rotateInboundAction } from "@/app/actions";
import { Button, Badge, PageHeader } from "@/components/ui";
import { Code, Empty, List, Row, Section, StatusPill } from "@/components/developers/parts";
import { CopyButton } from "@/components/FileActions";
import { DeleteWebhook, NewKeyForm, NewWebhookForm, RevokeKey } from "@/components/DevForms";

export const metadata = { title: "Integrations & API" };

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
  const apiCode = `# Open a file and send the agreement
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
curl -X POST ${base}/api/v1/files/{id}/void   -H "Authorization: Bearer cs_live_..." -d '{"reason":"duplicate"}'`;
  return (
    <>
      <PageHeader title="Integrations & API" sub="Open files from your CRM, case system or n8n so the agreement goes out with no one touching it." />
      <nav aria-label="On this page" className="-mt-3 mb-6 flex flex-wrap gap-2 text-sm">
        <a className="rounded-full border border-line bg-panel px-3 py-1.5 font-medium text-ink-2 hover:border-line-strong" href="#inbound">Inbound webhook</a>
        <a className="rounded-full border border-line bg-panel px-3 py-1.5 font-medium text-ink-2 hover:border-line-strong" href="#api">REST API</a>
        <a className="rounded-full border border-line bg-panel px-3 py-1.5 font-medium text-ink-2 hover:border-line-strong" href="#webhooks">Webhooks out</a>
      </nav>
      <div className="space-y-6">
        <Section
          id="inbound"
          title="1. No-code: inbound webhook"
          description="Point your CRM's new deal or matter automation, a Zapier zap or an n8n HTTP node at this URL."
        >
          <p className="text-sm leading-relaxed text-muted">
            Each POST opens a file and emails the agreement. Accepts JSON or form posts with <code>client_name</code>/<code>name</code>, <code>client_email</code>/<code>email</code>, and optional <code>company</code>, <code>ref</code>, <code>title</code>. <code>prefill</code> (the agreement&apos;s blanks) needs JSON. A repeated <code>ref</code> is rejected, so retries never double-send.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code aria-label="Inbound address" className="min-w-0 flex-1 break-all rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-xs">{inbound}</code>
            <div className="flex gap-2">
              <CopyButton text={inbound} />
              <form action={rotateInboundAction}><Button variant="ghost">Rotate</Button></form>
            </div>
          </div>
          <p className="text-xs text-muted">Rotating gives a new URL and stops the old one working, so update your automation straight after.</p>
          <Code label="Inbound webhook example">{`curl -X POST ${inbound} \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"Jordan Sample","client_email":"jordan@example.com","ref":"2026-0142"}'`}</Code>
          <p className="text-sm">
            <a className="font-medium text-brand" href="/integrations/n8n-countersign.json" download>Download the n8n workflow</a>
            <span className="text-muted">: &ldquo;new CRM record → send agreement → when signed, update the CRM; if declined, alert Slack&rdquo;.</span>
          </p>
        </Section>

        <Section id="api" title="2. REST API" description="Bearer-token API for your own systems. Keys are shown once and stored only as a hash.">
          <NewKeyForm />
          {keys.length > 0 ? (
            <List label="API keys">
              {keys.map((k) => (
                <Row key={k.id} muted={!!k.revoked_at}>
                  <span className="min-w-0 break-words font-medium">{k.name} <code className="ml-1 text-xs font-normal text-muted">{k.prefix}…</code></span>
                  <span className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted sm:justify-end">
                    {k.revoked_at ? <Badge tone="neutral">Revoked</Badge> : <span>{k.last_used_at ? `Used ${fmtDay(k.last_used_at)}` : "Never used"}</span>}
                    {!k.revoked_at && <RevokeKey id={k.id} />}
                  </span>
                </Row>
              ))}
            </List>
          ) : (
            <Empty icon="code" title="No API keys yet">Create a key above to call the API from your own systems. It is shown once, so copy it straight away.</Empty>
          )}
          {agreements.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line text-sm">
              <table className="w-full">
                <caption className="sr-only">Agreements and their agreement_id values</caption>
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-4 py-2">Agreement</th>
                    <th scope="col" className="px-4 py-2"><code>agreement_id</code></th>
                  </tr>
                </thead>
                <tbody>
                  {agreements.map((a) => (
                    <tr key={a.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">{a.name}{a.is_default ? <span className="ml-2 text-xs text-muted">(default: used when no agreement_id is sent)</span> : null}{!a.live ? <Badge tone="warn" className="ml-2">not published</Badge> : null}</td>
                      <td className="px-4 py-2"><code className="text-xs break-all">{a.id}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Code label="REST API examples">{apiCode}</Code>
        </Section>

        <Section
          id="webhooks"
          title="3. Webhooks out"
          description="We POST JSON when a file changes."
        >
          <p className="text-sm leading-relaxed text-muted">
            Each request carries <code>X-Countersign-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code>{"{t}.{body}"}</code> with your signing secret. Failed deliveries retry for about 15 hours (1m, 5m, 30m, 2h, 12h).
          </p>
          <NewWebhookForm events={WEBHOOK_EVENTS} />
          {hooks.length > 0 ? (
            <List label="Webhook endpoints">
              {hooks.map((h) => (
                <Row key={h.id}>
                  <span className="min-w-0 break-all">{h.url} <span className="ml-1 block text-xs text-muted sm:inline">{h.events === "*" ? "all events" : h.events.replace(/,/g, ", ")}</span></span>
                  <DeleteWebhook id={h.id} />
                </Row>
              ))}
            </List>
          ) : (
            <Empty icon="send" title="No webhooks yet">Add an endpoint above and we will POST to it when a file is created, signed or declined.</Empty>
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Recent deliveries</h3>
            {deliveries.length > 0 ? (
              <List label="Recent deliveries">
                {deliveries.map((d) => (
                  <Row key={d.id}>
                    <span className="min-w-0 break-all text-xs"><code>{d.event}</code> → {d.url}</span>
                    <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted">
                      <StatusPill status={d.status} code={d.response_code} />
                      {d.attempts > 1 ? `${d.attempts} tries` : null}
                      {d.last_error && d.status !== "delivered" ? <span className="break-all">{d.last_error}</span> : null}
                    </span>
                  </Row>
                ))}
              </List>
            ) : (
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-sm text-muted">No deliveries yet. They appear here as soon as a file changes.</p>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}
