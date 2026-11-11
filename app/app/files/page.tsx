import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all, one } from "@/lib/db";
import type { FileRow } from "@/lib/types";
import { agreements } from "@/lib/dashboard";
import { Card, LinkButton, PageHeader, inputCls } from "@/components/ui";
import { FilesTabs } from "@/components/files/FilesTabs";
import { FilesEmpty } from "@/components/files/FilesEmpty";
import { FileTable } from "@/components/FileTable";
import { CsvImport } from "@/components/ResetForms";

export const metadata = { title: "Files" };

const TABS: { key: string; label: string; where: string; statuses: string[] | null }[] = [
  { key: "all", label: "All", where: "1=1", statuses: null },
  { key: "open", label: "Waiting on client", where: "status IN ('sent','viewed')", statuses: ["sent", "viewed"] },
  { key: "signed", label: "Awaiting countersign", where: "status = 'signed'", statuses: ["signed"] },
  { key: "completed", label: "Completed", where: "status = 'completed'", statuses: ["completed"] },
  { key: "closed", label: "Declined / expired / voided", where: "status IN ('declined','expired','voided')", statuses: ["declined", "expired", "voided"] },
  { key: "draft", label: "Drafts", where: "status = 'draft'", statuses: ["draft"] },
];

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.status) ?? TABS[0];
  const q = (sp.q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const files = all<FileRow & { agreement: string }>(
    `SELECT f.*, t.name AS agreement FROM files f JOIN template_versions v ON v.id = f.template_version_id JOIN templates t ON t.id = v.template_id
     WHERE f.workspace_id = ? AND ${tab.where.replace(/status/g, "f.status")} AND (? = '' OR f.title LIKE ? OR f.client_name LIKE ? OR f.client_email LIKE ? OR f.ref LIKE ? OR f.client_company LIKE ?)
     ORDER BY f.created_at DESC LIMIT 200`,
    s.workspaceId, q, like, like, like, like, like,
  );
  const byStatus = new Map(
    all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM files
       WHERE workspace_id = ? AND (? = '' OR title LIKE ? OR client_name LIKE ? OR client_email LIKE ? OR ref LIKE ? OR client_company LIKE ?)
       GROUP BY status`,
      s.workspaceId, q, like, like, like, like, like,
    ).map((r) => [r.status, r.n]),
  );
  const count = (statuses: string[] | null) => (statuses ? statuses.reduce((n, k) => n + (byStatus.get(k) ?? 0), 0) : [...byStatus.values()].reduce((n, v) => n + v, 0));
  // The tab counts follow the search; whether the workspace has any files at all does not.
  const hasAny = count(null) > 0 || (q !== "" && one("SELECT 1 FROM files WHERE workspace_id = ? LIMIT 1", s.workspaceId) !== undefined);
  const tabs = TABS.map((t) => ({ key: t.key, label: t.label, count: count(t.statuses) }));
  return (
    <>
      <PageHeader
        title="Files"
        sub="One row per job or case. Each one carries its client agreement."
        actions={
          <>
            <a href="/api/files/export" className="inline-flex items-center rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-gray-50">Export CSV</a>
            <LinkButton href="/app/files/new">+ New file</LinkButton>
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilesTabs tabs={tabs} active={tab.key} q={q} />
        <form role="search" className="w-full lg:w-72">
          <input type="hidden" name="status" value={tab.key} />
          <input name="q" type="search" defaultValue={q} placeholder="Search client, company, email, ref…" aria-label="Search files" className={inputCls} />
        </form>
      </div>
      <p className="mb-2 text-[13px] text-muted" aria-live="polite">
        {files.length === 200 ? "Showing the latest 200" : `${files.length} ${files.length === 1 ? "file" : "files"}`}
        {q && (
          <>
            {" "}matching “{q}” ·{" "}
            <Link href={`/app/files?status=${tab.key}`} className="font-medium text-brand hover:underline">Clear search</Link>
          </>
        )}
      </p>
      <Card>
        <FileTable files={files} empty={<FilesEmpty q={q} tabLabel={tab.label} hasAny={hasAny} canOpen={hasAny || agreements(s.workspaceId).some((a) => a.liveVersion != null)} admin={s.role !== "staff"} />} />
      </Card>
      <details className="mt-6 rounded-xl border border-line bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">Import a backlog of files from CSV</summary>
        <div className="mt-3"><CsvImport /></div>
      </details>
    </>
  );
}
