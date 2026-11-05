import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { getWorkspace } from "@/lib/files";
import type { FileRow } from "@/lib/types";
import { Card, LinkButton, Notice, PageHeader, cx } from "@/components/ui";
import { FileTable } from "@/components/FileTable";

export const metadata = { title: "Command center" };

function hours(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}

// request-time cutoffs (kept out of render for React's purity rule)
function since(days: number) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireSession();
  const ws = getWorkspace(s.workspaceId);
  const { error } = await searchParams;
  const counts = Object.fromEntries(
    all<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM files WHERE workspace_id = ? GROUP BY status", ws.id).map((r) => [r.status, r.n]),
  ) as Record<string, number>;
  const waiting = (counts.sent ?? 0) + (counts.viewed ?? 0);
  const stuck = one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE workspace_id = ? AND status IN ('sent','viewed') AND sent_at < ?", ws.id, since(3))?.n ?? 0;
  const done30 = one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE workspace_id = ? AND status = 'completed' AND completed_at > ?", ws.id, since(30))?.n ?? 0;
  const durations = all<{ sent_at: string; client_signed_at: string }>(
    "SELECT sent_at, client_signed_at FROM files WHERE workspace_id = ? AND client_signed_at IS NOT NULL AND sent_at IS NOT NULL ORDER BY client_signed_at DESC LIMIT 50",
    ws.id,
  ).map((r) => new Date(r.client_signed_at).getTime() - new Date(r.sent_at).getTime());
  const median = durations.length ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : NaN;

  const tpl = one<{ id: string; active_version_id: string | null; draft: string | null }>(
    "SELECT t.id, t.active_version_id, (SELECT v.id FROM template_versions v WHERE v.template_id = t.id AND v.status = 'draft' ORDER BY v.version DESC LIMIT 1) AS draft FROM templates t WHERE t.workspace_id = ? AND t.archived = 0 ORDER BY t.is_default DESC, t.created_at DESC LIMIT 1",
    ws.id,
  );
  const anyFile = !!one("SELECT 1 FROM files WHERE workspace_id = ? LIMIT 1", ws.id);
  const steps = [
    { done: !!tpl, label: "Upload your client agreement", href: "/app/agreements", cta: "Upload" },
    { done: !!tpl?.active_version_id, label: "Check the fields we found and publish", href: tpl?.draft ? `/app/agreements/${tpl.draft}` : "/app/agreements", cta: "Review" },
    { done: !!ws.countersign_image, label: "Adopt your firm's countersignature", href: "/app/settings#countersign", cta: "Adopt" },
    { done: anyFile, label: "Open your first file. The agreement goes out automatically", href: "/app/files/new", cta: "New file" },
  ];
  const setupDone = steps.every((x) => x.done);

  const attention = all<FileRow>(
    `SELECT * FROM files WHERE workspace_id = ? AND (status IN ('signed','declined','expired') OR (status IN ('sent','viewed') AND sent_at < ?))
     ORDER BY COALESCE(client_signed_at, declined_at, sent_at) DESC LIMIT 8`,
    ws.id,
    since(3),
  );
  const recent = all<FileRow>("SELECT * FROM files WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 8", ws.id);

  const stats = [
    { label: "Waiting on clients", value: waiting, href: "/app/files?status=open" },
    { label: "Waiting 3+ days", value: stuck, href: "/app/files?status=open", warn: stuck > 0 },
    { label: "Completed (30 days)", value: done30, href: "/app/files?status=completed" },
    { label: "Median time to sign", value: hours(median), href: "/app/files?status=completed" },
  ];

  return (
    <>
      <PageHeader title="Command center" sub={`Every file's client agreement, in one place.`} actions={<LinkButton href="/app/files/new">+ New file</LinkButton>} />
      {error === "admin" && <div className="mb-4"><Notice tone="warn">That page is for workspace admins.</Notice></div>}
      {!setupDone && (
        <Card className="mb-6 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Get set up</h2>
            <span className="text-xs text-muted">{steps.filter((x) => x.done).length} of {steps.length} done</span>
          </div>
          <ol className="space-y-2">
            {steps.map((st, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", st.done ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-muted")}>{st.done ? "✓" : i + 1}</span>
                  <span className={cx("text-sm", st.done && "text-muted line-through")}>{st.label}</span>
                </div>
                {!st.done && <LinkButton variant="secondary" className="shrink-0 py-1.5 text-xs" href={st.href}>{st.cta}</LinkButton>}
              </li>
            ))}
          </ol>
        </Card>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((st) => (
          <Link key={st.label} href={st.href}>
            <Card className="p-4 transition hover:border-brand/40">
              <div className="text-xs font-medium text-muted">{st.label}</div>
              <div className={cx("mt-1 text-2xl font-semibold tabular", st.warn && "text-warn")}>{st.value}</div>
            </Card>
          </Link>
        ))}
      </div>
      {attention.length > 0 && (
        <Card className="mb-6">
          <div className="border-b border-line px-5 py-3">
            <h2 className="font-semibold">Needs attention</h2>
            <p className="text-xs text-muted">Waiting on your countersignature, declined, expired, or unsigned after 3 days.</p>
          </div>
          <FileTable files={attention} empty="" />
        </Card>
      )}
      <Card>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-semibold">Recent files</h2>
          <Link href="/app/files" className="text-sm font-medium text-brand">View all</Link>
        </div>
        <FileTable files={recent} empty={<>No files yet. <Link className="font-medium text-brand" href="/app/files/new">Open your first file</Link> and the agreement goes out on its own.</>} />
      </Card>
    </>
  );
}
