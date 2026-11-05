import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import type { FileRow } from "@/lib/types";
import { Card, LinkButton, PageHeader, cx, inputCls } from "@/components/ui";
import { FileTable } from "@/components/FileTable";

export const metadata = { title: "Files" };

const TABS: { key: string; label: string; where: string }[] = [
  { key: "all", label: "All", where: "1=1" },
  { key: "open", label: "Waiting on client", where: "status IN ('sent','viewed')" },
  { key: "signed", label: "Awaiting countersign", where: "status = 'signed'" },
  { key: "completed", label: "Completed", where: "status = 'completed'" },
  { key: "closed", label: "Declined / expired / voided", where: "status IN ('declined','expired','voided')" },
  { key: "draft", label: "Drafts", where: "status = 'draft'" },
];

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.status) ?? TABS[0];
  const q = (sp.q ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const files = all<FileRow & { agreement: string }>(
    `SELECT f.*, t.name AS agreement FROM files f JOIN template_versions v ON v.id = f.template_version_id JOIN templates t ON t.id = v.template_id
     WHERE f.workspace_id = ? AND ${tab.where.replace(/status/g, "f.status")} AND (? = '' OR f.title LIKE ? OR f.client_name LIKE ? OR f.client_email LIKE ? OR f.ref LIKE ?)
     ORDER BY f.created_at DESC LIMIT 200`,
    s.workspaceId, q, like, like, like, like,
  );
  return (
    <>
      <PageHeader title="Files" sub="One row per job or case. Each one carries its client agreement." actions={<LinkButton href="/app/files/new">+ New file</LinkButton>} />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <Link key={t.key} href={`/app/files?status=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={cx("rounded-full border px-3 py-1 text-sm", t.key === tab.key ? "border-brand bg-brand/10 font-medium text-brand" : "border-line bg-white text-muted hover:text-ink")}>
              {t.label}
            </Link>
          ))}
        </div>
        <form className="lg:w-72">
          <input type="hidden" name="status" value={tab.key} />
          <input name="q" defaultValue={q} placeholder="Search client, email, ref…" className={inputCls} />
        </form>
      </div>
      <Card>
        <FileTable files={files} empty={q ? "No files match that search." : "Nothing here yet."} />
      </Card>
    </>
  );
}
