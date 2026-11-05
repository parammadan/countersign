import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import { Card, Notice, PageHeader, cx } from "@/components/ui";
import { UploadAgreement } from "@/components/UploadAgreement";
import { TemplateMenu } from "@/components/TemplateMenu";
import { testFileAction } from "@/app/actions";

export const metadata = { title: "Agreements" };

export default async function Page({ searchParams }: { searchParams: Promise<{ published?: string }> }) {
  const s = await requireSession();
  const { published } = await searchParams;
  const tpls = all<{ id: string; name: string; is_default: number; active_version_id: string | null; created_at: string }>(
    "SELECT * FROM templates WHERE workspace_id = ? AND archived = 0 ORDER BY is_default DESC, created_at DESC",
    s.workspaceId,
  );
  const versions = all<{ id: string; template_id: string; version: number; status: string; source_name: string; created_at: string; published_at: string | null; files: number }>(
    `SELECT v.id, v.template_id, v.version, v.status, v.source_name, v.created_at, v.published_at, (SELECT COUNT(*) FROM files f WHERE f.template_version_id = v.id) files
     FROM template_versions v WHERE v.workspace_id = ? ORDER BY v.version DESC`,
    s.workspaceId,
  );
  const admin = s.role !== "staff";
  return (
    <>
      <PageHeader title="Agreements" sub="The agreement every client signs. Upload it once, and each new file sends it out." />
      {published && <div className="mb-4"><Notice tone="ok">Published. New files now use this version. <Link className="font-medium underline" href="/app/files/new">Open a file</Link></Notice></div>}
      {tpls.length === 0 && admin && <UploadAgreement />}
      <div className="space-y-4">
        {tpls.map((t) => {
          const vs = versions.filter((v) => v.template_id === t.id);
          const draft = vs.find((v) => v.status === "draft");
          return (
            <Card key={t.id}>
              <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">
                    {t.name} {t.is_default ? <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-muted">Default</span> : null}
                  </h2>
                  <p className="text-sm text-muted">
                    {t.active_version_id ? `Version ${vs.find((v) => v.id === t.active_version_id)?.version} is live` : "Not published yet"}
                  </p>
                </div>
                {admin && (
                  <div className="flex flex-wrap items-center gap-2">
                    {t.active_version_id && (
                      <form action={testFileAction}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <button className="rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-gray-50" title="Opens a file with you as the client, so you can see exactly what clients see">
                          Send a test to me
                        </button>
                      </form>
                    )}
                    {draft && (
                      <Link href={`/app/agreements/${draft.id}`} className="rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white shadow-sm">
                        Review draft v{draft.version}
                      </Link>
                    )}
                    <TemplateMenu templateId={t.id} name={t.name} isDefault={!!t.is_default} />
                  </div>
                )}
              </div>
              <ul className="divide-y divide-line">
                {vs.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/app/agreements/${v.id}`} className="font-medium hover:text-brand">Version {v.version}</Link>
                      <span className="ml-2 truncate text-muted">{v.source_name}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                      <span>{v.files} file{v.files === 1 ? "" : "s"}</span>
                      <span className={cx("rounded-full px-2 py-0.5 font-medium", v.id === t.active_version_id ? "bg-emerald-50 text-emerald-700" : v.status === "draft" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-600")}>
                        {v.id === t.active_version_id ? "Live" : v.status === "draft" ? "Draft" : "Retired"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {admin && (
                <div className="border-t border-line px-5 py-3 text-sm">
                  <UploadAgreement templateId={t.id} compact />
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {tpls.length > 0 && admin && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-brand">Add a different agreement (e.g. for another service line)</summary>
          <div className="mt-3"><UploadAgreement /></div>
        </details>
      )}
    </>
  );
}
