import Link from "next/link";
import { draftDisclosures } from "@/lib/drafts/disclosures";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import { fallbackNotice, getDraft, MODEL_NOTICES, versions } from "@/lib/drafts/service";
import { authorizeDraft } from "@/lib/drafts/roles";
import { claimIsStale } from "@/lib/drafts/store";
import { Notice } from "@/components/ui";
import { DraftEditor, type EditorProps } from "@/components/studio/DraftEditor";
import { approvedClausePicks } from "@/lib/clauses/app/service";

export const metadata = { title: "Draft" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string; why?: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const q = await searchParams;
  const g = getDraft(s, id);
  const notIncluded = draftDisclosures(s.workspaceId, id);
  if (!g.ok) notFound();
  const h = versions(s, id);
  if (!h.ok) notFound();
  // show names, not ids: only members of this workspace
  const people = new Map(all<{ id: string; name: string }>("SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?", s.workspaceId).map((u) => [u.id, u.id === s.userId ? "you" : u.name]));
  const who = (uid: string) => people.get(uid) ?? "former member";
  const authors = new Set([g.draft.created_by, ...h.versions.map((v) => v.author)]);
  const scope = { workspaceId: g.draft.workspace_id, lastEditor: g.draft.last_editor, authors: [...authors] };
  const props: EditorProps = {
    draftId: g.draft.id,
    status: g.draft.status,
    version: g.version.number,
    doc: g.version.doc as EditorProps["doc"],
    publishedVersionId: g.draft.published_version_id,
    staleClaim: g.draft.status === "publishing" && claimIsStale(g.draft.publish_claimed_at),
    can: {
      edit: authorizeDraft(s, scope, "edit").ok,
      approve: authorizeDraft(s, scope, "request_changes").ok, // role only; the author rule is shown separately
      publish: authorizeDraft(s, scope, "publish").ok,
      // the server refuses anyway; this only hides a button that would fail
      isLastEditor: g.draft.last_editor === s.userId || authors.has(s.userId),
    },
    versions: h.versions.map((v) => ({ ...v, author: who(v.author) })),
    log: h.log.map((l) => ({ ...l, actor: who(l.actor) })),
    // usable Clause Library clauses (id, title, version, placeholders; one query; empty on any failure). The server
    // renders and re-checks the clause when it is used.
    library: approvedClausePicks(s),
  };
  return (
    <>
      <div className="mb-3 text-sm text-muted"><Link href="/app/studio" className="hover:text-ink">Agreement Studio</Link> / {g.draft.title}</div>
      {q.new === "template" && <div className="mb-4"><Notice tone="info">Drafted from the template with exactly the values you gave.</Notice></div>}
      {q.new === "template_fallback" && <div className="mb-4"><Notice tone="warn">{fallbackNotice(q.why)}</Notice></div>}
      {q.new === "model" && <div className="mb-4"><Notice tone="info">{MODEL_NOTICES.model}</Notice></div>}
      {q.new === "model_unchanged" && <div className="mb-4"><Notice tone="info">{MODEL_NOTICES.model_unchanged}</Notice></div>}
      {notIncluded.length > 0 && (
        <div className="mb-4">
          <Notice tone="warn">
            <p className="font-medium">Not in this draft: your description asked for {notIncluded.length === 1 ? "this, and the template can't include it" : "these, and the template can't include them"}. Check before you approve or send it.</p>
            <ul className="mt-1 list-disc pl-5">{notIncluded.map((d, i) => <li key={i}>{d.label ? <><span className="font-medium">{d.label}:</span> </> : null}{d.text}</li>)}</ul>
          </Notice>
        </div>
      )}
      <DraftEditor {...props} />
    </>
  );
}
