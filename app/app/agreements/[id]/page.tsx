import Link from "next/link";
import { fmtDay } from "@/lib/time";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getTemplateVersion } from "@/lib/templates";
import { AppError, getWorkspace } from "@/lib/files";
import { FieldEditor } from "@/components/FieldEditor";
import { newDraftAction } from "@/app/actions";
import { Button, Notice } from "@/components/ui";
import type { Field, PageSize } from "@/lib/fields";

export const metadata = { title: "Review agreement" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  let tv;
  try {
    tv = getTemplateVersion(s.workspaceId, id);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { template, version } = tv;
  const ws = getWorkspace(s.workspaceId);
  const readOnly = version.status !== "draft" || s.role === "staff";
  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/agreements" className="hover:text-ink">Agreements</Link> / {template.name} / v{version.version}
      </div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{readOnly ? template.name : `Check the fields in “${template.name}”`}</h1>
        {version.status === "published" && s.role !== "staff" && (
          <form action={newDraftAction}>
            <input type="hidden" name="versionId" value={version.id} />
            <Button variant="secondary">Edit fields (new version)</Button>
          </form>
        )}
      </div>
      {!readOnly && (
        <div className="mb-4">
          <Notice tone="info">
            We read the agreement and marked where everyone signs. <b>Blue</b> is the client, <b>violet</b> is your firm (signed automatically), <b>amber</b> is filled from each file. Fix anything that&apos;s off, then publish.
          </Notice>
        </div>
      )}
      {version.status === "published" && (
        <div className="mb-4">
          <Notice tone="ok">Published {version.published_at ? fmtDay(version.published_at) : ""}. Read-only: files already sent keep exactly this version.</Notice>
        </div>
      )}
      <FieldEditor
        versionId={version.id}
        pdfUrl={`/api/versions/${version.id}/pdf`}
        pages={JSON.parse(version.pages_json) as PageSize[]}
        initial={JSON.parse(version.fields_json) as Field[]}
        detection={JSON.parse(version.detection_json)}
        readOnly={readOnly}
        firmName={ws.legal_name}
      />
    </>
  );
}
