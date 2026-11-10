import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { SOURCE_KINDS, isSuperseded, type ClauseVersion, type Params } from "@/lib/clauses";
import {
  CLAUSE_KIND_LABEL, SOURCE_KIND_LABEL, STATE_LABEL, STATE_TONE, capabilitiesOf, getClause, memberNames, previewVersion,
} from "@/lib/clauses/app/service";
import {
  addVersionAction, approveClauseAction, editDraftAction, retireClauseAction, sendBackClauseAction, submitClauseAction,
} from "@/app/clauses-actions";
import { Badge, Button, Card, CardHeader, Field, Notice, PageHeader, Select, inputCls, timeAgo } from "@/components/ui";
import { failureText } from "@/lib/clauses/app/messages";

export const metadata = { title: "Clause" };

const OK: Record<string, string> = {
  created: "Draft created. Submit it when it's ready; another owner or admin approves it.",
  saved: "Draft saved.",
  version: "New draft version created.",
  submitted: "Submitted for approval. Another owner or admin can now approve it or send it back.",
  approved: "Approved. This version can now be used in agreements; earlier versions can't.",
  sentback: "Sent back to the author as a draft.",
  retired: "Retired. It can no longer be used, and older versions stay unusable.",
};
const SAMPLE: Record<string, string> = { text: "Example Client LLC", multiline: "First line.\nSecond line.", int: "30", money: "1500", date: "2027-01-15" };

function Body({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-words rounded-md border border-line bg-subtle px-3 py-2 font-sans text-[13px] leading-relaxed text-ink">{text}</pre>;
}

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireSession();
  const { id } = await params;
  const q = await searchParams;
  const r = getClause(s, id);
  if (!r.ok || !r.value) notFound();
  const c = r.value;
  const caps = capabilitiesOf(s);
  const names = memberNames(s);
  const who = (u: string) => (u === s.userId ? "you" : names.get(u) ?? "a former member");
  const versions = [...c.versions].reverse();
  const open = c.versions.some((v) => v.state === "draft" || v.state === "in_review");
  const latest = c.versions[c.versions.length - 1];

  // Preview with sample values: ?v=<version>&p.<path>=<value>. Read-only, any version the member can read.
  const pv = Number(q.v) || latest.version;
  const pVersion = c.versions.find((v) => v.version === pv) ?? latest;
  const sample: Params = Object.fromEntries(pVersion.placeholders.map((p) => [p.path, q[`p.${p.path}`] ?? SAMPLE[p.type]]));
  const preview = previewVersion(s, c.id, pVersion.version, sample);

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/app/clauses" className="hover:text-ink">Clause Library</Link>}
        title={c.title}
        sub={<>{CLAUSE_KIND_LABEL[c.kind]} · created by {who(c.createdBy)} {timeAgo(c.createdAt)}</>}
        actions={<Badge tone={STATE_TONE[latest.state]}>{`v${latest.version} ${STATE_LABEL[latest.state]}`}</Badge>}
      />
      {q.error && <div className="mb-4"><Notice tone="error">{failureText(q.error, q.issue)}</Notice></div>}
      {q.ok && Object.hasOwn(OK, q.ok) && <div className="mb-4"><Notice tone="ok">{OK[q.ok]}</Notice></div>}

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          {versions.map((v) => <VersionCard key={v.version} v={v} all={c.versions} clauseId={c.id} me={s.userId} caps={caps} who={who} />)}
          {!open && caps.includes("edit") && (
            <Card>
              <CardHeader title="New version" description="Approved text is never edited: a change is a new draft that goes through approval again." />
              <form action={addVersionAction} className="space-y-4 px-5 pb-5">
                <input type="hidden" name="id" value={c.id} />
                <Field label="Clause text"><textarea name="body" required rows={6} maxLength={20000} defaultValue={latest.body} className={inputCls} /></Field>
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <Field label="Source">
                    <Select name="sourceKind" defaultValue={latest.provenance.source.kind}>
                      {SOURCE_KINDS.map((k) => <option key={k} value={k}>{SOURCE_KIND_LABEL[k]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Reference" hint="Optional, e.g. TPL-2026">
                    <input name="sourceRef" maxLength={15} defaultValue={latest.provenance.source.ref ?? ""} className={inputCls} pattern="[A-Za-z]{2,6}-[0-9]{1,8}" />
                  </Field>
                </div>
                <Button type="submit" variant="secondary" icon="plus">Create version {c.versions.length + 1}</Button>
              </form>
            </Card>
          )}
        </div>

        <Card className="self-start">
          <CardHeader title="Preview" description="Rendered with sample values, exactly as it would be inserted. Values with markup, links or hidden characters are refused." />
          <form method="get" className="space-y-3 px-5">
            <Field label="Version">
              <Select name="v" defaultValue={String(pVersion.version)}>
                {versions.map((v) => <option key={v.version} value={v.version}>{`v${v.version} (${STATE_LABEL[v.state]})`}</option>)}
              </Select>
            </Field>
            {pVersion.placeholders.map((p) => (
              <Field key={p.path} label={`${p.path} (${p.type})`}>
                {p.type === "multiline"
                  ? <textarea name={`p.${p.path}`} rows={2} defaultValue={String(sample[p.path])} className={inputCls} />
                  : <input name={`p.${p.path}`} defaultValue={String(sample[p.path])} className={inputCls} />}
              </Field>
            ))}
            <Button type="submit" variant="secondary" size="sm">Render</Button>
          </form>
          <div className="px-5 pt-3 pb-5" aria-live="polite">
            {preview.ok ? <Body text={preview.value} /> : <Notice tone="warn">{preview.message}</Notice>}
          </div>
        </Card>
      </div>
    </>
  );
}

function VersionCard({ v, all, clauseId, me, caps, who }: { v: ClauseVersion; all: ClauseVersion[]; clauseId: string; me: string; caps: string[]; who: (u: string) => string }) {
  const mine = v.provenance.author === me;
  const usable = v.state === "approved" && !isSuperseded(all, v.version);
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2">Version {v.version} <Badge tone={STATE_TONE[v.state]}>{STATE_LABEL[v.state]}</Badge>{v.state === "approved" && <Badge tone={usable ? "brand" : "neutral"}>{usable ? "In use" : "Superseded"}</Badge>}</span>}
        description={<>By {who(v.provenance.author)} · {SOURCE_KIND_LABEL[v.provenance.source.kind]}{v.provenance.source.ref ? ` ${v.provenance.source.ref}` : ""}{v.approvedBy ? ` · approved by ${who(v.approvedBy)}` : ""}</>}
      />
      <div className="space-y-4 px-5 pb-5">
        {v.state === "draft" && mine && caps.includes("edit") ? (
          <form action={editDraftAction} className="space-y-3">
            <input type="hidden" name="id" value={clauseId} />
            <input type="hidden" name="n" value={v.version} />
            <textarea name="body" required rows={6} maxLength={20000} defaultValue={v.body} className={inputCls} aria-label={`Version ${v.version} text`} />
            <Button type="submit" variant="secondary" size="sm">Save draft</Button>
          </form>
        ) : (
          <Body text={v.body} />
        )}
        {v.placeholders.length > 0 && (
          <p className="text-xs text-muted">Placeholders: {v.placeholders.map((p) => `${p.path} (${p.type})`).join(", ")}</p>
        )}

        <div className="flex flex-wrap items-start gap-2">
          {v.state === "draft" && mine && caps.includes("edit") && (
            <form action={submitClauseAction}>
              <input type="hidden" name="id" value={clauseId} />
              <input type="hidden" name="n" value={v.version} />
              <Button type="submit" size="sm" icon="send">Submit for approval</Button>
            </form>
          )}
          {v.state === "in_review" && caps.includes("approve") && !mine && (
            <>
              <form action={approveClauseAction}>
                <input type="hidden" name="id" value={clauseId} />
                <input type="hidden" name="n" value={v.version} />
                <Button type="submit" size="sm" icon="check">Approve</Button>
              </form>
              <form action={sendBackClauseAction} className="flex gap-2">
                <input type="hidden" name="id" value={clauseId} />
                <input type="hidden" name="n" value={v.version} />
                <input name="note" maxLength={300} placeholder="Reason (optional)" aria-label="Reason for sending back" className={inputCls + " h-8 py-1 text-xs"} />
                <Button type="submit" size="sm" variant="secondary">Send back</Button>
              </form>
            </>
          )}
          {v.state === "in_review" && mine && <p className="text-xs text-muted">Waiting for another owner or admin to approve it. You can&apos;t approve your own text.</p>}
          {v.state === "in_review" && !mine && !caps.includes("approve") && <p className="text-xs text-muted">Waiting for an owner or admin to approve it.</p>}
          {v.state === "approved" && caps.includes("approve") && (
            <form action={retireClauseAction} className="flex gap-2">
              <input type="hidden" name="id" value={clauseId} />
              <input type="hidden" name="n" value={v.version} />
              <input name="note" maxLength={300} placeholder="Reason (optional)" aria-label="Reason for retiring" className={inputCls + " h-8 py-1 text-xs"} />
              <Button type="submit" size="sm" variant="danger">Retire</Button>
            </form>
          )}
        </div>

        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">History ({v.history.length})</summary>
          <ol className="mt-2 space-y-1">
            {v.history.map((h, i) => (
              <li key={i}>
                {h.from ? `${STATE_LABEL[h.from]} → ${STATE_LABEL[h.to]}` : "Created as draft"} by {who(h.by)} · {timeAgo(h.at)}{h.note ? ` · “${h.note}”` : ""}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </Card>
  );
}
