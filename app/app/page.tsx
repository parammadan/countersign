import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import { getWorkspace } from "@/lib/files";
import type { FileRow } from "@/lib/types";
import { activity, agreements, attention, ATTENTION_TEXT, fileMetrics, nextAction, type AttentionReason, type NextAction } from "@/lib/dashboard";
import { Badge, Card, CardHeader, cx, EmptyState, LinkButton, Notice, PageHeader, Stat, timeAgo } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { FileTable } from "@/components/FileTable";
import { ExploreAi } from "@/components/ExploreAi";
import { aiState } from "@/lib/ai/budget";
import { verificationRequired } from "@/lib/emailverify";
import { configuredProvider } from "@/lib/ai/anthropic";

export const metadata = { title: "Overview" };

// request time, read once per request (kept out of render for React's purity rule)
function requestTime() {
  return Date.now();
}

function duration(ms: number | null) {
  if (!ms || ms <= 0) return null;
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

const REASON_UI: Record<AttentionReason, { icon: IconName; tone: "bad" | "warn" | "brand" | "neutral" }> = {
  email_failed: { icon: "mail", tone: "bad" },
  countersign: { icon: "pen", tone: "brand" },
  copy_failed: { icon: "mail", tone: "warn" },
  declined: { icon: "error", tone: "bad" },
  expired: { icon: "clock", tone: "warn" },
  waiting: { icon: "clock", tone: "neutral" },
};
const DOT: Record<"bad" | "warn" | "brand" | "neutral" | "ok", string> = {
  bad: "bg-bad-bg text-bad",
  warn: "bg-warn-bg text-warn",
  brand: "bg-brand-soft text-brand",
  neutral: "bg-gray-100 text-muted",
  ok: "bg-ok-bg text-ok",
};

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; confirmed?: string }> }) {
  const s = await requireSession();
  const ws = getWorkspace(s.workspaceId);
  const { error, confirmed } = await searchParams;
  const admin = s.role !== "staff";
  const now = requestTime();

  const att = attention(ws.id, now);
  const m = fileMetrics(ws.id, now);
  const ags = agreements(ws.id);
  const act = activity(ws.id, 6);
  const recent = all<FileRow>(
    "SELECT id, title, ref, client_name, client_email, status, sent_at, completed_at, declined_at, voided_at, client_signed_at, viewed_at, created_at FROM files WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 6",
    ws.id,
  );

  const live = ags.filter((a) => a.liveVersion != null).length;
  // no model call: whether AI would run for this workspace now, for the "Explore AI features" card
  const ai = aiState(ws.id, configuredProvider() !== null, 0.05);
  const askable = ags.find((a) => a.liveVersionId) ?? null;
  const drafts = ags.filter((a) => a.draftVersionId).length;
  const firstDraft = ags.find((a) => a.draftVersionId && a.liveVersion == null) ?? ags.find((a) => a.draftVersionId);
  const steps = [
    { done: ags.length > 0, label: "Upload your client agreement", href: "/app/agreements" },
    { done: live > 0, label: "Check the fields and publish", href: firstDraft ? `/app/agreements/${firstDraft.draftVersionId}` : "/app/agreements" },
    { done: !!ws.countersign_image, label: "Adopt your firm's countersignature", href: "/app/settings#countersign" },
    { done: m.total > 0, label: "Open your first client file", href: "/app/files/new" },
  ];
  const setupLeft = steps.filter((x) => !x.done).length;
  const next = nextAction({ admin, agreements: ags, hasCountersignature: !!ws.countersign_image, hasFiles: m.total > 0, top: att.items[0], attentionTotal: att.total });

  const reasonSummary = (Object.entries(att.byReason) as [AttentionReason, number][])
    .filter(([, n]) => n > 0)
    .slice(0, 2)
    .map(([r, n]) => `${n} ${ATTENTION_TEXT[r].label.toLowerCase()}`)
    .join(" · ");
  const median = duration(m.medianSignMs);

  return (
    <>
      <PageHeader
        title="Overview"
        sub={`Where every client agreement at ${ws.name} stands, and what needs you next.`}
        actions={<LinkButton href="/app/files/new" icon="plus">New file</LinkButton>}
      />
      <div className="space-y-6">
        {error === "admin" && <Notice tone="warn">That page is for workspace admins.</Notice>}
        {confirmed && <Notice tone="ok">Email confirmed. You can now send agreements to clients.</Notice>}

        <NextStep next={next} steps={setupLeft > 0 ? steps : null} admin={admin} />

        <ExploreAi ai={ai} askHref={askable ? `/app/agreements/${askable.liveVersionId}/ask` : null} verifyHelp={verificationRequired()} />

        <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4 [&>*]:min-w-0">
          <Stat label="Needs attention" value={att.total} tone={att.total ? "warn" : undefined} href="#attention" hint={att.total ? reasonSummary : "Nothing waiting on you"} />
          <Stat label="Awaiting signature" value={m.awaiting} href="/app/files?status=open" hint={`${m.opened} opened by the client`} />
          <Stat label="Ready for work" value={m.ready} href="/app/files?status=completed" hint={`${m.ready30} in the last 30 days${median ? ` · ${median} median to sign` : ""}`} />
          <Stat label="Live agreements" value={live} href="/app/agreements" hint={drafts ? `${drafts} draft${drafts === 1 ? "" : "s"} to review` : ags.length ? "No drafts waiting" : "None uploaded yet"} />
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card id="attention" className="scroll-mt-6 self-start">
            <CardHeader
              title="Needs attention"
              description="Most urgent first. Each one opens the file, where you can act on it."
              action={att.total > 0 ? <Badge tone="warn">{att.total}</Badge> : <Badge tone="ok" icon="check">All clear</Badge>}
            />
            {att.items.length ? (
              <>
                <ul className="divide-y divide-line">
                  {att.items.map((it) => {
                    const t = ATTENTION_TEXT[it.reason];
                    const ui = REASON_UI[it.reason];
                    return (
                      <li key={it.fileId} className="relative flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-subtle">
                        <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", DOT[ui.tone])}>
                          <Icon name={ui.icon} size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Link href={`/app/files/${it.fileId}`} className="font-medium text-ink after:absolute after:inset-0 hover:text-brand">
                              {it.clientName}
                            </Link>
                            <span className="text-[13px] text-ink-2">{t.label}</span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted">
                            {it.title}
                            {it.ref ? ` · Ref ${it.ref}` : ""}
                          </div>
                          <div className="mt-1 text-xs font-medium text-brand sm:hidden">{t.adminAction && !admin ? "Needs an admin" : t.action}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xs text-muted tabular">{timeAgo(it.since)}</div>
                          <div className="mt-1 hidden items-center gap-1 text-xs font-medium text-brand sm:flex">
                            {t.adminAction && !admin ? "Needs an admin" : t.action}
                            <Icon name="chevronRight" size={14} />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {att.total > att.items.length && (
                  <p className="border-t border-line px-5 py-3 text-xs text-muted">
                    Showing the {att.items.length} most urgent of {att.total}.
                  </p>
                )}
              </>
            ) : (
              <EmptyState icon="checkCircle" title="Nothing needs attention">
                Failed emails, declined or expired links, clients waiting 3+ days and manual countersignatures will show up here.
              </EmptyState>
            )}
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader title="Agreements" action={<Link href="/app/agreements" className="text-[13px] font-medium text-brand hover:underline">Manage</Link>} />
              {ags.length ? (
                <ul className="divide-y divide-line">
                  {ags.slice(0, 4).map((a) => (
                    <li key={a.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">{a.name}</span>
                        {a.liveVersion != null ? (
                          <Badge tone="ok" icon="check">v{a.liveVersion} live</Badge>
                        ) : (
                          <Badge tone="warn">Not published</Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        <span>{a.files} file{a.files === 1 ? "" : "s"}</span>
                        {a.draftVersionId && (
                          <>
                            <span aria-hidden>·</span>
                            <Link href={`/app/agreements/${a.draftVersionId}`} className="font-medium text-brand hover:underline">
                              Draft v{a.draftVersion} to review
                            </Link>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon="agreement" title="No agreement yet" action={admin ? <LinkButton href="/app/agreements" size="sm" icon="upload">Upload agreement</LinkButton> : undefined}>
                  {admin ? "Upload the agreement you already send clients." : "An admin uploads the firm's agreement."}
                </EmptyState>
              )}
            </Card>

            <Card>
              <CardHeader title="Recent activity" />
              {act.length ? (
                <ol className="px-5 py-3">
                  {act.map((e, i) => (
                    <li key={e.seq} className="relative flex gap-3 pb-3.5 last:pb-0">
                      {i < act.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-line" />}
                      <span aria-hidden className={cx("relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-white ring-1", e.type === "file.completed" || e.type === "file.countersigned" ? "bg-ok ring-emerald-200" : e.type === "file.email_failed" || e.type === "file.declined" ? "bg-bad ring-red-200" : "bg-brand ring-brand/25")} />
                      <div className="min-w-0 text-[13px]">
                        <div className="text-ink">{e.text}</div>
                        {e.subject &&
                          (e.fileId ? (
                            <Link href={`/app/files/${e.fileId}`} className="block truncate text-ink-2 hover:text-brand hover:underline">{e.subject}</Link>
                          ) : (
                            <div className="truncate text-ink-2">{e.subject}</div>
                          ))}
                        <div className="truncate text-xs text-muted">
                          {e.actor} · {timeAgo(e.at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-5 py-6 text-center text-sm text-muted">Activity shows up here as agreements and files move.</p>
              )}
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader title="Recent files" action={<Link href="/app/files" className="text-[13px] font-medium text-brand hover:underline">View all</Link>} />
          <FileTable
            files={recent}
            empty={
              <>
                No files yet.{" "}
                <Link className="font-medium text-brand" href="/app/files/new">
                  Open your first file
                </Link>{" "}
                and the agreement goes out on its own.
              </>
            }
          />
        </Card>
      </div>
    </>
  );
}

function NextStep({ next, steps, admin }: { next: NextAction; steps: { done: boolean; label: string; href: string }[] | null; admin: boolean }) {
  const tone = next.tone === "attention" ? "warn" : next.tone === "clear" ? "ok" : "brand";
  const icon: IconName = next.tone === "attention" ? "alert" : next.tone === "clear" ? "checkCircle" : "arrowRight";
  const done = steps?.filter((x) => x.done).length ?? 0;
  return (
    <Card className="overflow-hidden">
      <div className={cx("grid grid-cols-1", steps && "lg:grid-cols-[minmax(0,1fr)_320px]")}>
        <section aria-labelledby="next-step" className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
          <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-full", DOT[tone])}>
            <Icon name={icon} size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold tracking-wide text-muted uppercase">Next step</div>
            <h2 id="next-step" className="mt-1 text-lg font-semibold tracking-tight text-ink">{next.title}</h2>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">{next.body}</p>
          </div>
          {next.href && next.cta && (
            <LinkButton href={next.href} className="self-start sm:self-center">
              {next.cta}
              <Icon name="arrowRight" size={16} />
            </LinkButton>
          )}
        </section>
        {steps && (
          <section aria-labelledby="setup" className="border-t border-line bg-subtle p-5 sm:p-6 lg:border-t-0 lg:border-l">
            <div className="flex items-center justify-between">
              <h2 id="setup" className="text-sm font-semibold text-ink">Get set up</h2>
              <span className="text-xs text-muted tabular">{done} of {steps.length} done</span>
            </div>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
              <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${(done / steps.length) * 100}%` }} />
            </div>
            <ol className="mt-4 space-y-2.5">
              {steps.map((st, i) => (
                <li key={st.label} className="flex items-center gap-2.5 text-[13px]">
                  <span className={cx("grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold", st.done ? "bg-ok text-white" : "border border-line-strong bg-white text-muted")}>
                    {st.done ? <Icon name="check" size={12} /> : i + 1}
                  </span>
                  {st.done ? (
                    <span className="text-muted line-through decoration-line-strong">
                      <span className="sr-only">Done: </span>
                      {st.label}
                    </span>
                  ) : admin || i === 3 ? (
                    <Link href={st.href} className="font-medium text-ink hover:text-brand hover:underline">{st.label}</Link>
                  ) : (
                    <span className="text-ink-2">{st.label} <span className="text-muted">(an admin)</span></span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </Card>
  );
}
