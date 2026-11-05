import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import { customPrefillKeys, type Field } from "@/lib/fields";
import { Card, Notice, PageHeader } from "@/components/ui";
import { NewFileForm } from "@/components/NewFileForm";

export const metadata = { title: "New file" };

export default async function Page() {
  const s = await requireSession();
  const tpls = all<{ id: string; name: string; is_default: number; fields_json: string }>(
    `SELECT t.id, t.name, t.is_default, v.fields_json FROM templates t JOIN template_versions v ON v.id = t.active_version_id
     WHERE t.workspace_id = ? AND t.archived = 0 ORDER BY t.is_default DESC, t.created_at DESC`,
    s.workspaceId,
  );
  return (
    <>
      <PageHeader title="New file" sub="Enter the client. The agreement is filled in and emailed to them for signature right away." />
      {tpls.length === 0 ? (
        <Notice tone="warn">
          You need a published agreement first. <Link className="font-medium underline" href="/app/agreements">Upload your client agreement</Link>.
        </Notice>
      ) : (
        <Card className="max-w-2xl p-5 sm:p-6">
          <NewFileForm templates={tpls.map((t) => ({ id: t.id, name: t.name, prefill: customPrefillKeys(JSON.parse(t.fields_json) as Field[]) }))} />
        </Card>
      )}
    </>
  );
}
