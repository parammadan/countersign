import Link from "next/link";
import { fmtDateTime } from "@/lib/time";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { AppError, COPY_LINK_DAYS, copyLinkClosed, getFile, getVersion, getWorkspace, readiness, signingLink, versionFields } from "@/lib/files";
import { EVENT_TEXT, fileEvents } from "@/lib/audit";
import { fileStages, nextStep, reminderPlan, type Stage } from "@/lib/filepage";
import { Badge, Card, Notice, StatusBadge, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { CopyButton, FileActions, VoidFile } from "@/components/FileActions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { isLiveStatus } from "@/components/poll";
import { emailMode } from "@/lib/email";
import type { FileRow } from "@/lib/types";

export const metadata = { title: "File" };

const fmt = fmtDateTime;
const utc = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const SOURCE: Record<string, string> = { user: "the app", api: "the API", inbound: "inbound webhook", system: "automation" };
const EMAIL_KIND: Record<string, string> = {
  invite: "Invitation", resend: "Invitation (again)", reminder: "Reminder", otp: "Verification code", completed: "Signed copy",
  firm_completed: "Firm: completed", firm_ready: "Firm: countersign needed", firm_declined: "Firm: declined",
};

type Email = { id: string; kind: string; to_email: string; subject: string; status: string; created_at: string; error: string | null };

function delivery(m: Email | undefined) {
  if (!m) return { label: "Not sent", tone: "neutral" as const };
  if (m.status === "sent") return { label: "Delivered to the mail server", tone: "ok" as const };
  if (m.status === "failed") return { label: `Failed: ${m.error ?? "provider error"}`, tone: "bad" as const };
  return { label: "Recorded in the email log only (no email provider)", tone: "neutral" as const };
}

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
  const ws = getWorkspace(s.workspaceId);
  const admin = s.role !== "staff";
  const v = getVersion(f.template_version_id);
  const tpl = one<{ id: string; name: string; active_version_id: string | null }>("SELECT id, name, active_version_id FROM templates WHERE id = ?", v.template_id)!;
  const liveVersion = tpl.active_version_id && tpl.active_version_id !== v.id ? one<{ version: number }>("SELECT version FROM template_versions WHERE id = ?", tpl.active_version_id)?.version : null;
  const events = fileEvents(f.id);
  const emails = all<Email>("SELECT id, kind, to_email, subject, status, created_at, error FROM emails WHERE file_id = ? ORDER BY created_at DESC, rowid DESC", f.id);
  const docs = all<{ kind: string; sha256: string; created_at: string }>("SELECT kind, sha256, created_at FROM documents WHERE file_id = ? ORDER BY created_at", f.id);
  const final = docs.find((d) => d.kind === "final");
  const clientSigned = docs.find((d) => d.kind === "client_signed");
  const link = signingLink(f);
  const prefill = JSON.parse(f.prefill_json || "{}") as Record<string, string>;
  const fields = versionFields(v);
  const outbox = emailMode() === "outbox";
  const lastInvite = emails.find((m) => ["invite", "resend", "reminder"].includes(m.kind));
  const inviteFailed = f.email_status === "failed" || (!outbox && lastInvite?.status === "failed");
  const lastCopy = emails.find((m) => m.kind === "completed");
  const copyFailed = f.status === "completed" && !f.copy_emailed_at && lastCopy?.status === "failed";
  const canResendCopy = f.status === "completed" && !!final && !f.copy_emailed_at && !outbox;
  const ready = await readiness(f);
  const failedCheck = ready.checks.find((c) => c.required && !c.ok);
  const step = nextStep(f, {
    admin, inviteFailed, inviteError: lastInvite?.error ?? f.email_error, ready: ready.ready,
    readinessProblem: failedCheck ? `${failedCheck.label}: ${failedCheck.detail ?? "not met"}.` : undefined,
    copyEmailed: !!f.copy_emailed_at, copyFailed, outbox, autoCountersign: !!ws.auto_countersign,
  });
  const stages = fileStages(f, ready.ready);
  const plan = reminderPlan(f, ws.reminder_days);
  const ev = (type: string) => [...events].reverse().find((e) => e.type === type);
  const signedEv = ev("file.signed");
  const csEv = ev("file.countersigned");
  const signedData = JSON.parse(signedEv?.data_json ?? "{}") as Record<string, string>;
  const csData = JSON.parse(csEv?.data_json ?? "{}") as Record<string, string>;
  const open = f.status === "sent" || f.status === "viewed";
  const toneCls = { ok: "border-emerald-300 bg-emerald-50/50", info: "border-blue-200 bg-blue-50/40", warn: "border-amber-300 bg-amber-50/50", error: "border-red-300 bg-red-50/50", neutral: "border-line bg-subtle" }[step.tone];
  const toneIcon = { ok: "checkCircle", info: "info", warn: "alert", error: "error", neutral: "x" }[step.tone] as "checkCircle" | "info" | "alert" | "error" | "x";
  const pending = f.status !== "completed";

  return (
    <>
      {/* while the file waits on the client or a countersignature, its status updates without a reload */}
      <AutoRefresh active={isLiveStatus(f.status)} />
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/files" className="hover:text-ink">Files</Link> / {f.ref || f.id}
      </div>
      <div className="mb-5 min-w-0">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          <span className="min-w-0 break-words">{f.title}</span> <StatusBadge status={f.status} />
        </h1>
        <p className="mt-1 text-sm text-muted">
          <Link href={`/app/agreements/${v.id}`} className="hover:text-ink">{tpl.name} · version {v.version}</Link> · created {fmt(f.created_at)} via {SOURCE[f.source] ?? f.source}
        </p>
      </div>

      {created && open && !inviteFailed && !outbox && (
        <div className="mb-4"><Notice tone="ok">Sent to {f.client_email}. You&apos;ll be notified when they sign.</Notice></div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* the next thing that has to happen, and the actions for it */}
          <section aria-labelledby="next-step" className={cx("rounded-[var(--radius-lg)] border p-5 shadow-1", toneCls)}>
            <div className="flex items-start gap-3">
              <span className={cx("mt-0.5 shrink-0", { ok: "text-emerald-600", info: "text-blue-600", warn: "text-amber-600", error: "text-red-600", neutral: "text-muted" }[step.tone])}>
                <Icon name={toneIcon} size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Next step</p>
                <h2 id="next-step" className="text-[17px] font-semibold text-ink">{step.title}</h2>
                <p className="mt-1 text-sm text-ink-2">{step.body}</p>
                <div className="mt-4">
                  <FileActions fileId={f.id} status={f.status} link={link} admin={admin} inviteFailed={inviteFailed} canResendCopy={canResendCopy} copyFailed={copyFailed} countersigner={ws.countersigner_name || ws.legal_name} />
                </div>
                {open && link && (
                  <p className="mt-3 text-xs text-muted">
                    Signing link: <span className="font-mono">{new URL(link).host}/s/••••••••</span>. It&apos;s personal to {f.client_name}; anyone with it can sign, so share it only with them.
                  </p>
                )}
              </div>
            </div>
          </section>

          <Card className="p-5">
            <h2 className="mb-4 font-semibold">Progress</h2>
            <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:gap-2" aria-label="Progress">
              {stages.map((st) => <StageItem key={st.key} st={st} />)}
            </ol>
          </Card>

          <Card className={cx("p-5", ready.ready && "border-emerald-300")}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Readiness checklist</h2>
              {ready.ready ? <Badge tone="ok" icon="checkCircle">All required checks passed</Badge> : f.status === "completed" ? <Badge tone="bad">A required check failed</Badge> : <Badge>In progress</Badge>}
            </div>
            <ul className="space-y-1.5 text-sm" aria-label="Readiness checks">
              {ready.checks.map((c) => {
                const state = c.ok ? "passed" : pending && c.key !== "not_voided" ? "pending" : c.required ? "failed" : "warning";
                return (
                  <li key={c.key} className="flex items-start gap-2">
                    <span aria-hidden className={cx("mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", { passed: "bg-emerald-600 text-white", pending: "border border-gray-300 bg-white text-transparent", failed: "bg-red-600 text-white", warning: "bg-amber-500 text-white" }[state])}>
                      {state === "passed" ? "✓" : state === "pending" ? "" : "!"}
                    </span>
                    <span className={cx(state === "pending" && "text-muted")}>
                      <span className="sr-only">{{ passed: "Passed: ", pending: "Not yet: ", failed: "Failed: ", warning: "Warning: " }[state]}</span>
                      {c.label}
                      {!c.required && <span className="text-muted"> (optional)</span>}
                      {c.detail && state !== "pending" && <span className="block text-xs text-muted">{c.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>

          {f.status === "completed" && final && (
            <Card role="region" aria-labelledby="signed-agreement">
              <h2 id="signed-agreement" className="border-b border-line px-5 py-3 font-semibold">Signed agreement</h2>
              <div className="space-y-5 p-5 text-sm">
                <div className="flex flex-wrap gap-2">
                  <a href={`/api/files/${f.id}/document`} className="inline-flex items-center gap-2 rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                    <Icon name="arrowRight" size={16} /> Download signed PDF
                  </a>
                  {clientSigned && (
                    <a href={`/api/files/${f.id}/document?kind=client_signed`} className="inline-flex items-center rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium hover:bg-gray-50">
                      Client-signed copy (before countersigning)
                    </a>
                  )}
                </div>
                <p className="text-xs text-muted">The signed PDF ends with a certificate of completion: both parties, times, IP addresses, signing method, the full audit trail and the fingerprints below.</p>

                <div>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Integrity</h3>
                  <p className="flex items-start gap-2">
                    <span className={ready.checks.find((c) => c.key === "sealed")?.ok ? "text-emerald-600" : "text-red-600"}><Icon name={ready.checks.find((c) => c.key === "sealed")?.ok ? "shield" : "error"} size={16} /></span>
                    <span>{ready.checks.find((c) => c.key === "sealed")?.ok ? "The stored PDF matches the fingerprint recorded when it was sealed (checked when this page loaded)." : ready.checks.find((c) => c.key === "sealed")?.detail}</span>
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-muted">SHA-256 {final.sha256}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <CopyButton text={final.sha256} label="Copy fingerprint" size="sm" />
                    <Link href="/verify" target="_blank" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                      Verify a copy of the PDF <Icon name="external" size={13} />
                    </Link>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Evidence</h3>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                    <Evidence label="Client signed" value={f.client_signed_at ? utc(f.client_signed_at) : "-"} sub={`${f.client_name} · ${f.client_email}${signedEv?.ip ? ` · IP ${signedEv.ip}` : ""}${signedData.method ? ` · ${signedData.method} signature` : ""}${f.otp_verified_at ? " · email code verified" : ""}`} />
                    <Evidence label="Firm countersigned" value={f.completed_at ? utc(f.completed_at) : "-"} sub={`${ws.countersigner_name || ws.legal_name} · ${csEv?.actor === "auto-countersign" || csData.method?.includes("automatically") ? "applied automatically" : `applied by ${csEv?.actor ?? "-"}`}`} />
                    <Evidence label="Agreement version" value={`${tpl.name}, version ${v.version}`} sub={`SHA-256 ${v.sha256.slice(0, 16)}…`} />
                    {clientSigned && <Evidence label="Client-signed copy" value={utc(clientSigned.created_at)} sub={`SHA-256 ${clientSigned.sha256.slice(0, 16)}…`} />}
                  </dl>
                </div>

                <div>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Client&apos;s copy</h3>
                  {f.copy_emailed_at ? (
                    <p className="flex items-center gap-2"><span className="text-emerald-600"><Icon name="checkCircle" size={16} /></span> Emailed to {f.client_email} on {fmt(f.copy_emailed_at)}.</p>
                  ) : (
                    <p className="flex items-start gap-2">
                      <span className={copyFailed ? "text-red-600" : "text-muted"}><Icon name={copyFailed ? "error" : "info"} size={16} /></span>
                      <span>
                        {copyFailed ? `The email with the signed copy failed (${lastCopy?.error ?? "provider error"}).` : outbox ? "Not emailed: email delivery isn't configured on this server." : "Not emailed yet."}{" "}
                        {copyLinkClosed(f) ? "The client's download link has closed; download the PDF and send it yourself." : `${f.client_name} can still download it from their signing link for ${COPY_LINK_DAYS} days after completion.`}
                        {canResendCopy && " Use Resend signed copy above to email it again."}
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </Card>
          )}

          <Card>
            <h2 className="border-b border-line px-5 py-3 font-semibold">Activity</h2>
            <ol className="divide-y divide-line" aria-label="Audit trail">
              {events.map((e) => {
                const data = JSON.parse(e.data_json) as Record<string, string>;
                return (
                  <li key={e.seq} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className={cx("font-medium", e.type === "file.email_failed" && "text-bad")}>{EVENT_TEXT[e.type] ?? e.type}</span>
                      <span className="text-xs text-muted tabular">{utc(e.created_at)}</span>
                    </div>
                    <div className="mt-0.5 break-all text-xs text-muted">
                      {e.actor}
                      {e.ip ? ` · IP ${e.ip}` : ""}
                      {data.reason ? ` · “${data.reason}”` : ""}
                      {data.error ? ` · ${data.error}` : ""}
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
              <p className="px-5 py-4 text-sm text-muted">No emails for this file yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {emails.map((m) => (
                  <li key={m.id} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/app/outbox/${m.id}`} className="block truncate font-medium hover:text-brand">{EMAIL_KIND[m.kind] ?? m.kind}: {m.subject}</Link>
                      <div className="text-xs break-words text-muted">to {m.to_email} · {fmt(m.created_at)}{m.error ? ` · ${m.error}` : ""}</div>
                    </div>
                    {m.status === "sent" ? <Badge tone="ok">Delivered</Badge> : m.status === "failed" ? <Badge tone="bad">Failed</Badge> : <Badge>Logged only</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="min-w-0 space-y-6" aria-label="File details">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Client</h2>
            <dl className="space-y-2">
              <div><dt className="text-xs text-muted">Name</dt><dd>{f.client_name}</dd></div>
              <div><dt className="text-xs text-muted">Email</dt><dd className="break-all">{f.client_email}</dd></div>
              {f.client_company && <div><dt className="text-xs text-muted">Company</dt><dd>{f.client_company}</dd></div>}
              {f.ref && <div><dt className="text-xs text-muted">Reference</dt><dd className="break-all">{f.ref}</dd></div>}
              {Object.entries(prefill).map(([k, val]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{fields.find((x) => x.prefillKey === "custom." + k)?.label ?? k}</dt>
                  <dd className="break-words">{val || "-"}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Agreement</h2>
            <p><Link href={`/app/agreements/${v.id}`} className="font-medium hover:text-brand">{tpl.name}</Link></p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone="brand">Version {v.version}, pinned</Badge>
              {liveVersion && <span>New files use version {liveVersion}</span>}
            </p>
            <p className="mt-2 text-xs text-muted">This file always uses exactly version {v.version}, even after a newer version is published.</p>
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Signing</h2>
            <dl className="space-y-3">
              <Row label="Invitation" value={f.sent_at ? `Sent ${fmt(f.sent_at)}` : "Not sent"} sub={f.sent_at ? delivery(lastInvite).label : undefined} tone={delivery(lastInvite).tone} />
              {(open || f.reminders_sent > 0) && (
                <Row
                  label="Reminders"
                  value={`${f.reminders_sent} sent${f.last_reminder_at ? `, last ${fmt(f.last_reminder_at)}` : ""}`}
                  sub={plan.next ? `Next automatically ${fmt(plan.next)}` : plan.reason === "off" ? "Automatic reminders are off in Settings" : plan.reason === "expires_first" ? "No more before the link expires" : plan.reason === "done" ? "All scheduled reminders have gone out" : undefined}
                />
              )}
              {f.expires_at && !["completed", "voided", "signed"].includes(f.status) && <Row label={f.status === "expired" ? "Link expired" : "Link expires"} value={fmt(f.expires_at)} tone={f.status === "expired" ? "bad" : undefined} />}
              <Row label="Client" value={f.client_signed_at ? `Signed ${fmt(f.client_signed_at)}` : f.viewed_at ? `Opened ${fmt(f.viewed_at)}` : f.status === "declined" ? `Declined ${f.declined_at ? fmt(f.declined_at) : ""}` : "Not opened yet"} sub={[f.consent_at && "agreed to sign electronically", ws.require_otp && (f.otp_verified_at ? "email code verified" : "email code required")].filter(Boolean).join(" · ") || undefined} />
              <Row label="Your firm" value={f.completed_at ? `Countersigned ${fmt(f.completed_at)}` : ws.auto_countersign ? "Countersigns automatically when the client signs" : "An admin countersigns by hand"} sub={ws.countersigner_name ? `As ${ws.countersigner_name}${ws.countersigner_title ? `, ${ws.countersigner_title}` : ""}` : undefined} />
              {f.status === "voided" && <Row label="Voided" value={f.voided_at ? fmt(f.voided_at) : "-"} sub={JSON.parse(ev("file.voided")?.data_json ?? "{}").reason || undefined} tone="bad" />}
            </dl>
          </Card>

          {!["completed", "voided"].includes(f.status) && (
            <Card className="p-5 text-sm">
              <h2 className="mb-1 font-semibold">Stop this file</h2>
              <p className="mb-3 text-xs text-muted">Void it if it was opened by mistake or the engagement isn&apos;t going ahead.</p>
              <VoidFile fileId={f.id} />
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function StageItem({ st }: { st: Stage }) {
  const dot = { done: "bg-brand border-brand text-white", current: "border-brand bg-white text-brand", todo: "border-gray-300 bg-white text-transparent", stopped: "border-red-500 bg-red-500 text-white" }[st.state];
  return (
    <li className="flex min-w-0 items-start gap-2.5 sm:flex-col sm:gap-1.5" aria-current={st.state === "current" ? "step" : undefined}>
      <span aria-hidden className={cx("grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[10px] font-bold", dot)}>{st.state === "done" ? "✓" : st.state === "stopped" ? "×" : st.state === "current" ? "•" : ""}</span>
      <span className="min-w-0">
        <span className={cx("block text-sm font-medium sm:text-xs", st.state === "todo" ? "text-muted" : st.state === "stopped" ? "text-bad" : "text-ink")}>
          <span className="sr-only">{{ done: "Done: ", current: "In progress: ", todo: "Not yet: ", stopped: "Stopped: " }[st.state]}</span>
          {st.label}
        </span>
        <span className="block text-xs text-muted tabular sm:text-[11px]">{st.at ? fmtDateTime(st.at) : st.state === "current" ? "Waiting" : ""}</span>
      </span>
    </li>
  );
}

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "bad" | "neutral" }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx(tone === "bad" && "text-bad")}>{value}</dd>
      {sub && <dd className={cx("text-xs break-words", tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : "text-muted")}>{sub}</dd>}
    </div>
  );
}

function Evidence({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words">{value}</dd>
      {sub && <dd className="text-xs break-words text-muted">{sub}</dd>}
    </div>
  );
}
