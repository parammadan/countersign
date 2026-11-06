import Link from "next/link";
import { fmtDay } from "@/lib/time";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getTemplateVersion } from "@/lib/templates";
import { agreementLibrary } from "@/lib/library";
import { AppError, getWorkspace } from "@/lib/files";
import { FieldEditor } from "@/components/FieldEditor";
import { newDraftAction } from "@/app/actions";
import { Badge, Button, LinkButton, Notice, cx } from "@/components/ui";
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
  const admin = s.role !== "staff";
  const readOnly = version.status !== "draft" || !admin;
  const entry = agreementLibrary(s.workspaceId).find((a) => a.id === template.id)!;
  const here = entry.versions.find((v) => v.id === version.id)!;
  const live = entry.liveVersion;
  const archived = entry.state === "archived";

  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/agreements" className="hover:text-ink">Agreements</Link> / {template.name} / v{version.version}
      </div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{readOnly ? template.name : `Check the fields in “${template.name}”`}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {here.live ? <Badge tone="ok">Live</Badge> : version.status === "draft" ? <Badge tone="warn">Draft</Badge> : <Badge>Previous version</Badge>}
            {archived && <Badge>Archived</Badge>}
            <span>
              Version {version.version} · {version.source_name} · {version.status === "draft" ? `uploaded ${fmtDay(version.created_at)}` : `published ${version.published_at ? fmtDay(version.published_at) : ""}`}
              {version.status !== "draft" && ` · ${here.files} client file${here.files === 1 ? "" : "s"} use this version`}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {here.live && !archived && <LinkButton href={`/app/files/new?template=${template.id}`} icon="plus">Use for a new file</LinkButton>}
          {version.status === "published" && admin && !archived && (
            entry.draft ? (
              <LinkButton href={`/app/agreements/${entry.draft.id}`} variant="secondary" icon="pen">Open draft v{entry.draft.version}</LinkButton>
            ) : (
              <form action={newDraftAction}>
                <input type="hidden" name="versionId" value={version.id} />
                <Button variant="secondary" icon="pen">Edit fields (new version)</Button>
              </form>
            )
          )}
        </div>
      </div>

      {entry.versions.length > 1 && (
        <nav aria-label="Versions" className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Versions:</span>
          {[...entry.versions].reverse().map((v) => (
            <Link
              key={v.id}
              href={`/app/agreements/${v.id}`}
              aria-current={v.id === version.id ? "page" : undefined}
              className={cx("rounded-full border px-2.5 py-0.5", v.id === version.id ? "border-brand bg-brand/10 font-medium text-brand" : "border-line bg-white text-muted hover:text-ink")}
            >
              v{v.version}
              {v.live ? " · live" : v.status === "draft" ? " · draft" : ""}
            </Link>
          ))}
        </nav>
      )}

      {!readOnly && (
        <div className="mb-4">
          <Notice tone="info">
            We read the agreement and marked where everyone signs. <b>Blue</b> is the client, <b>violet</b> is your firm (signed automatically), <b>amber</b> is filled from each file. Check each one, fix anything that&apos;s off, then publish. Changes save as you go; nothing reaches a client until you publish.
          </Notice>
        </div>
      )}
      {version.status === "draft" && !admin && (
        <div className="mb-4"><Notice tone="info">This draft is waiting for an admin to check and publish it. You can look, but not change it.</Notice></div>
      )}
      {version.status === "published" && (
        <div className="mb-4">
          <Notice tone="ok">
            Published {version.published_at ? fmtDay(version.published_at) : ""}. Read-only: files already sent keep exactly this version.
            {!here.live && live && ` New files use version ${live.version}.`}
          </Notice>
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
        templateName={template.name}
        versionNumber={version.version}
        live={live && live.id !== version.id ? { version: live.version, files: live.files } : null}
      />
    </>
  );
}
