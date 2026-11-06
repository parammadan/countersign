import Link from "next/link";
import { fmtDateTime } from "@/lib/time";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { AppError, getFile, getVersion, readiness, signingLink, versionFields } from "@/lib/files";
import { EVENT_TEXT, fileEvents } from "@/lib/audit";
import { Card, Notice, StatusBadge, cx } from "@/components/ui";
import { FileActions } from "@/components/FileActions";
import { emailMode } from "@/lib/email";
import type { FileRow } from "@/lib/types";

export const metadata = { title: "File" };

const STEPS = [
  { key: "created", label: "Created" },
  { key: "sent", label: "Sent" },
  { key: "viewed", label: "Opened" },
  { key: "signed", label: "Client signed" },
  { key: "completed", label: "Countersigned" },
];

function stepDone(f: FileRow, k: string) {
  if (k === "created") return f.created_at;
  if (k === "sent") return f.sent_at;
  if (k === "viewed") return f.viewed_at || f.client_signed_at;
  if (k === "signed") return f.client_signed_at;
  if (k === "completed") return f.completed_at;
  return null;
}

const fmt = fmtDateTime;

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const { created } = await searchParams;
  let f: FileRow;
  try {
    f = getFile(s.workspaceId, id);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const v = getVersion(f.template_version_id);
  const tpl = one<{ name: string }>("SELECT name FROM templates WHERE id = ?", v.template_id)!;
  const events = fileEvents(f.id);
  const emails = all<{ id: string; kind: string; to_email: string; subject: string; status: string; created_at: string; error: string | null }>(
    "SELECT id, kind, to_email, subject, status, created_at, error FROM emails WHERE file_id = ? ORDER BY created_at DESC",
    f.id,
  );
  const docs = all<{ kind: string; sha256: string; created_at: string }>("SELECT kind, sha256, created_at FROM documents WHERE file_id = ? ORDER BY created_at", f.id);
  const link = signingLink(f);
  const prefill = JSON.parse(f.prefill_json || "{}") as Record<string, string>;
  const fields = versionFields(v);
  const outbox = emailMode() === "outbox";
  const lastInvite = emails.find((m) => ["invite", "resend", "reminder"].includes(m.kind));
  const inviteFailed = f.email_status === "failed" || (!outbox && lastInvite?.status === "failed");
  const ready = await readiness(f);
  const closed = ["declined", "voided", "expired"].includes(f.status);

  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/files" className="hover:text-ink">Files</Link> / {f.ref || f.id}
      </div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            <span className="min-w-0 break-words">{f.title}</span> <StatusBadge status={f.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {tpl.name} · version {v.version} · created {fmt(f.created_at)} via {({ user: "the app", api: "the API", inbound: "inbound webhook", system: "automation" } as Record<string, string>)[f.source] ?? f.source}
          </p>
        </div>
      </div>
      {created && f.status === "sent" && !inviteFailed && (
        <div className="mb-4">
          <Notice tone="ok">
            Sent to {f.client_email}. You&apos;ll be notified when they sign{f.status === "sent" ? ", and reminders go out on their own" : ""}.
            {outbox && " Email delivery isn't configured on this server, so use Copy signing link (or open it yourself to test the client's side)."}
          </Notice>
        </div>
      )}
      {f.status === "declined" && (
        <div className="mb-4">
          <Notice tone="error">
            Declined by the client: “{f.decline_reason}”. If the agreement itself needs changing, publish a new version and open a new file. If it was a misunderstanding, use <b>Send again</b>.
          </Notice>
        </div>
      )}
      {inviteFailed && (f.status === "sent" || f.status === "viewed") && (
        <div className="mb-4">
          <Notice tone="error">The last email to {f.client_email} wasn&apos;t delivered ({lastInvite?.error ?? "provider error"}). Use Copy signing link to send it another way, or Resend email to try again.</Notice>
        </div>
      )}

      <Card className="mb-6 p-5">
        <ol className="mb-5 grid grid-cols-5 gap-1">
          {STEPS.map((st) => {
            const at = stepDone(f, st.key);
            return (
              <li key={st.key} className="min-w-0">
                <div className={cx("h-1.5 rounded-full", at ? "bg-brand" : closed ? "bg-gray-200" : "bg-gray-200")} />
                <div className={cx("mt-2 truncate text-xs font-medium", at ? "text-ink" : "text-muted")}>{st.label}</div>
                <div className="truncate text-[11px] text-muted tabular">{at ? fmt(at) : ""}</div>
              </li>
            );
          })}
        </ol>
        <FileActions fileId={f.id} status={f.status} link={link} isAdmin={s.role !== "staff"} hasFinal={docs.some((d) => d.kind === "final")} />
        {link && (f.status === "sent" || f.status === "viewed") && (
          <div className="mt-3 truncate text-xs text-muted">
            Signing link: <a className="text-brand underline" href={link} target="_blank" rel="noreferrer">{link}</a>
          </div>
        )}
      </Card>

      {(f.status === "completed" || f.status === "signed") && (
        <Card className={cx("mb-6 p-5", ready.ready && "border-emerald-300")}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-semibold">{ready.ready ? "Ready for work" : "Not ready for work yet"}</h2>
            {ready.ready && <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">All required checks passed</span>}
          </div>
          <ul className="space-y-1.5 text-sm" aria-label="Readiness checks">
            {ready.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                <span aria-hidden className={cx("mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white", c.ok ? "bg-emerald-600" : c.required ? "bg-red-600" : "bg-amber-500")}>
                  {c.ok ? "✓" : "!"}
                </span>
                <span>
                  <span className="sr-only">{c.ok ? "Passed: " : c.required ? "Failed: " : "Warning: "}</span>
                  {c.label}
                  {!c.required && <span className="text-muted"> (optional)</span>}
                  {c.detail && <span className="block text-xs text-muted">{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card>
            <h2 className="border-b border-line px-5 py-3 font-semibold">Audit trail</h2>
            <ol className="divide-y divide-line">
              {events.map((e) => {
                const data = JSON.parse(e.data_json) as Record<string, string>;
                return (
                  <li key={e.seq} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{EVENT_TEXT[e.type] ?? e.type}</span>
                      <span className="text-xs text-muted tabular">{new Date(e.created_at).toISOString().replace("T", " ").slice(0, 19)} UTC</span>
                    </div>
                    <div className="mt-0.5 break-all text-xs text-muted">
                      {e.actor}
                      {e.ip ? ` · IP ${e.ip}` : ""}
                      {data.reason ? ` · “${data.reason}”` : ""}
                      {data.sha256 ? ` · sha256 ${data.sha256.slice(0, 16)}…` : ""}
                      {data.method ? ` · ${data.method}` : ""}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
          <Card>
            <h2 className="border-b border-line px-5 py-3 font-semibold">Emails</h2>
            {emails.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {emails.map((m) => (
                  <li key={m.id} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/app/outbox/${m.id}`} className="block truncate font-medium hover:text-brand">{m.subject}</Link>
                      <div className="text-xs text-muted">to {m.to_email} · {fmt(m.created_at)}{m.error ? ` · ${m.error}` : ""}</div>
                    </div>
                    <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs", m.status === "sent" ? "bg-emerald-50 text-emerald-700" : m.status === "failed" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600")}>
                      {m.status === "logged" ? "logged" : m.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Client</h2>
            <dl className="space-y-2">
              <div><dt className="text-xs text-muted">Name</dt><dd>{f.client_name}</dd></div>
              <div><dt className="text-xs text-muted">Email</dt><dd className="break-all">{f.client_email}</dd></div>
              {f.client_company && <div><dt className="text-xs text-muted">Company</dt><dd>{f.client_company}</dd></div>}
              {f.ref && <div><dt className="text-xs text-muted">Reference</dt><dd>{f.ref}</dd></div>}
              {f.expires_at && !["completed", "voided"].includes(f.status) && (
                <div><dt className="text-xs text-muted">Link expires</dt><dd>{fmt(f.expires_at)}</dd></div>
              )}
              {Object.entries(prefill).map(([k, val]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{fields.find((x) => x.prefillKey === "custom." + k)?.label ?? k}</dt>
                  <dd>{val || "-"}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {docs.length > 0 && (
            <Card className="p-5 text-sm">
              <h2 className="mb-3 font-semibold">Documents</h2>
              <ul className="space-y-3">
                {docs.map((d) => (
                  <li key={d.kind}>
                    <a className="font-medium text-brand" href={`/api/files/${f.id}/document?kind=${d.kind}`}>
                      {d.kind === "final" ? "Completed agreement + certificate" : "Client-signed copy"}
                    </a>
                    <div className="break-all font-mono text-[11px] text-muted">sha256 {d.sha256}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
