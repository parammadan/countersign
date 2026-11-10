"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, Notice, inputCls, cx } from "@/components/ui";
import { abortPublishAction, approveAction, editAction, exportAction, publishAction, requestChangesAction, rollbackAction, submitAction } from "@/app/studio-actions";

type Clause = { id: string; number?: string; heading?: string; text: string; locked?: boolean };
type Doc = { title: string; parties: { role: string; name: string }[]; clauses: Clause[] };
export type EditorProps = {
  draftId: string;
  status: "draft" | "pending_approval" | "approved" | "publishing" | "published";
  version: number;
  doc: Doc;
  publishedVersionId: string | null;
  /** a publish claim old enough to be cancelled by hand */
  staleClaim: boolean;
  can: { edit: boolean; approve: boolean; publish: boolean; isLastEditor: boolean };
  versions: { number: number; origin: string; author: string; created_at: string; restored_from: number | null }[];
  log: { action: string; actor: string; version_number: number; created_at: string }[];
};

const STATUS: Record<EditorProps["status"], { label: string; tone: "neutral" | "warn" | "ok" }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  publishing: { label: "Publishing", tone: "warn" },
  published: { label: "Published", tone: "ok" },
};

function download(base64: string, contentType: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function DraftEditor(p: EditorProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [heading, setHeading] = useState("");
  const [msg, setMsg] = useState<{ tone: "error" | "ok" | "warn"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const editable = p.can.edit && p.status !== "published";

  const run = (fn: () => Promise<{ ok: boolean; message?: string } & Record<string, unknown>>, ok?: string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      if (!r.ok) setMsg({ tone: "error", text: (r.message as string) || "That didn't work." });
      else {
        if (ok) setMsg({ tone: "ok", text: ok });
        setEditing(null);
        setAdding(null);
        router.refresh();
      }
    });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {msg && <Notice tone={msg.tone === "ok" ? "ok" : msg.tone === "warn" ? "warn" : "error"}>{msg.text}</Notice>}
        <Card>
          <CardHeader
            title={p.doc.title}
            description={p.doc.parties.map((x) => `${x.role}: ${x.name}`).join(" · ")}
            action={<Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label} · v{p.version}</Badge>}
          />
          <ol className="divide-y divide-line">
            {p.doc.clauses.map((c) => (
              <li key={c.id} className="px-5 py-4">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <h3 className="text-[14px] font-semibold text-ink">
                    {c.number ? `${c.number}. ` : ""}{c.heading ?? ""}
                    {c.locked && <span className="ml-2 align-middle"><Badge tone="neutral" icon="shield">Locked</Badge></span>}
                  </h3>
                  {editable && !c.locked && editing !== c.id && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => { setEditing(c.id); setText(c.text); }}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => run(() => editAction(p.draftId, p.version, { op: "delete_clause", clauseId: c.id }), "Clause removed; a new version was saved.")}>Remove</Button>
                    </div>
                  )}
                </div>
                {editing === c.id ? (
                  <div className="space-y-2">
                    <textarea className={cx(inputCls, "min-h-32 font-[inherit]")} value={text} onChange={(e) => setText(e.target.value)} />
                    <div className="flex gap-2">
                      <Button size="sm" loading={pending} onClick={() => run(() => editAction(p.draftId, p.version, { op: "replace_clause", clauseId: c.id, text }), "Saved as a new version.")}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-[14px] leading-6 text-ink-2">{c.text}</p>
                )}
                {editable && !c.locked && (adding === c.id ? (
                  <div className="mt-3 space-y-2 rounded-md border border-line p-3">
                    <input className={inputCls} placeholder="Heading" value={heading} maxLength={120} onChange={(e) => setHeading(e.target.value)} />
                    <textarea className={cx(inputCls, "min-h-24")} placeholder="Clause text" value={text} onChange={(e) => setText(e.target.value)} />
                    <div className="flex gap-2">
                      <Button size="sm" loading={pending} onClick={() => run(() => editAction(p.draftId, p.version, { op: "add_clause", after: c.id, text, heading }), "Clause added; later clauses and references were renumbered.")}>Add clause</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button className="mt-2 text-[12px] text-muted hover:text-ink" onClick={() => { setAdding(c.id); setText(""); setHeading(""); }}>+ Add a clause after this one</button>
                ))}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader title="Review and approval" description="Approval is by an owner or admin who didn't edit this draft. Approve and publish re-check parties, layout and the PDF." />
          <div className="space-y-2 px-5 py-4">
            {p.status === "draft" && p.can.edit && <Button className="w-full" loading={pending} onClick={() => run(() => submitAction(p.draftId, p.version), "Sent for approval.")}>Submit for approval</Button>}
            {p.status === "pending_approval" && p.can.approve && !p.can.isLastEditor && (
              <>
                <Button className="w-full" loading={pending} onClick={() => run(() => approveAction(p.draftId, p.version), "Approved.")}>Approve v{p.version}</Button>
                <Button className="w-full" variant="secondary" loading={pending} onClick={() => run(() => requestChangesAction(p.draftId), "Sent back for changes.")}>Request changes</Button>
              </>
            )}
            {p.status === "pending_approval" && p.can.approve && p.can.isLastEditor && <Notice tone="info">You edited this draft, so someone else must approve it.</Notice>}
            {p.status === "pending_approval" && !p.can.approve && <Notice tone="info">Waiting for an owner or admin to approve.</Notice>}
            {p.status === "approved" && p.can.publish && (
              <Button className="w-full" loading={pending} onClick={() => run(async () => {
                const r = await publishAction(p.draftId, p.version);
                if (r.ok && "agreementVersionId" in r) router.push(`/app/agreements/${r.agreementVersionId}?fromStudio=1`);
                return r;
              })}>Publish to Agreements</Button>
            )}
            {p.status === "publishing" && !p.staleClaim && <Notice tone="info">Being published. This takes a few seconds; reload to see the result.</Notice>}
            {p.status === "publishing" && p.staleClaim && p.can.publish && (
              <>
                <Notice tone="warn">Publishing started over 10 minutes ago and didn&apos;t finish. Check Agreements, then cancel it here to publish again.</Notice>
                <Button className="w-full" variant="secondary" loading={pending} onClick={() => run(() => abortPublishAction(p.draftId), "Publishing cancelled; the draft is approved again.")}>Cancel publishing</Button>
              </>
            )}
            {p.status === "published" && p.publishedVersionId && (
              <Notice tone="ok">Published. <Link className="underline" href={`/app/agreements/${p.publishedVersionId}`}>Open it in Agreements</Link> to place signature fields and send it for signing.</Notice>
            )}
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await exportAction(p.draftId, "pdf"); if (r.ok && "base64" in r) download(r.base64 as string, r.contentType as string, r.filename as string); return r; })}>PDF</Button>
              <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await exportAction(p.draftId, "docx"); if (r.ok && "base64" in r) download(r.base64 as string, r.contentType as string, r.filename as string); return r; })}>DOCX</Button>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Versions" />
          <ul className="divide-y divide-line text-[13px]">
            {p.versions.map((v) => (
              <li key={v.number} className="flex items-center justify-between gap-2 px-5 py-2.5">
                <span>v{v.number} · {v.origin}{v.restored_from ? ` of v${v.restored_from}` : ""} <span className="text-muted">· {v.author}</span></span>
                {editable && v.number !== p.version && <Button size="sm" variant="ghost" onClick={() => run(() => rollbackAction(p.draftId, p.version, v.number), `Restored v${v.number} as a new version.`)}>Restore</Button>}
              </li>
            ))}
          </ul>
        </Card>
        {p.log.length > 0 && (
          <Card>
            <CardHeader title="History" />
            <ul className="divide-y divide-line text-[13px]">
              {p.log.map((l, i) => <li key={i} className="px-5 py-2.5">{l.action.replace("_", " ")} v{l.version_number} <span className="text-muted">· {l.actor}</span></li>)}
            </ul>
          </Card>
        )}
      </aside>
    </div>
  );
}
