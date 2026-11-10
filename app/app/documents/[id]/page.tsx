import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getIntake } from "@/lib/intake/service";
import type { Source } from "@/lib/intake/types";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader, timeAgo } from "@/components/ui";
import { DECISION_LABEL, DECISION_TONE, TYPE_LABEL } from "@/components/intake/labels";

export const metadata = { title: "Document" };

const src = (s: Source) => `p. ${s.page}`;
const MAX_ROWS = 60;

function Rows({ rows }: { rows: { label: string; value: string; source?: Source }[] }) {
  if (!rows.length) return <p className="px-5 py-4 text-[13px] text-muted">None found.</p>;
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <ul className="divide-y divide-line">
      {rows.length > MAX_ROWS && <li className="px-5 py-2 text-[12px] text-muted">Showing {MAX_ROWS} of {rows.length}.</li>}
      {shown.map((r, i) => (
        <li key={i} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-muted">{r.label}</span>
            <span className="text-right text-[14px] font-medium text-ink">{r.value}</span>
          </div>
          {r.source && <blockquote className="mt-1 truncate text-[12px] text-muted" title={r.source.quote}>{src(r.source)}: “{r.source.quote}”</blockquote>}
        </li>
      ))}
    </ul>
  );
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const g = getIntake(s, id);
  if (!g.ok) notFound();
  const { result } = g;
  const r = result.record;
  const decision = r.routing.decision;
  const name = result.filename ?? (result.source === "paste" ? "Pasted text" : "Document");
  return (
    <>
      <div className="mb-3 text-sm text-muted"><Link href="/app/documents" className="hover:text-ink">Document Intelligence</Link> / {name}</div>
      <PageHeader
        title={name}
        sub={`${TYPE_LABEL[r.documentType.type] ?? r.documentType.type} · ${r.pageCount} page${r.pageCount === 1 ? "" : "s"} · read ${timeAgo(result.created_at)} by rules (no AI)`}
        actions={<Badge tone={DECISION_TONE[decision]}>{DECISION_LABEL[decision]}</Badge>}
      />
      <div className="mb-5 space-y-3">
        {decision === "ready_to_prepare" && <Notice tone="ok">Every required field was found, with no conflicts or warnings. Check the values below before you start a draft.</Notice>}
        {decision === "needs_review" && (
          <Notice tone="warn">
            A person needs to review this document before anything is prepared:
            <ul className="mt-1 list-disc pl-5">{r.routing.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          </Notice>
        )}
        {decision === "unsupported" && <Notice tone="info">{r.routing.reasons.join("; ")}. Nothing can be prepared from it.</Notice>}
        {result.draft_id && (
          <Notice tone="info">
            A draft was started from this document {timeAgo(result.confirmed_at)} after the values were confirmed: <Link className="underline" href={`/app/studio/${result.draft_id}`}>open the draft</Link>.
          </Notice>
        )}
        {decision !== "unsupported" && (
          <div>
            <LinkButton href={`/app/documents/${result.id}/draft`} icon="agreement" variant={decision === "ready_to_prepare" ? "primary" : "secondary"}>
              Start a draft in Agreement Studio
            </LinkButton>
            <p className="mt-1 text-[12px] text-muted">Opens the Studio form with only the values found here filled in. You confirm each one; nothing is generated until you press Generate.</p>
          </div>
        )}
      </div>

      {r.injection.length > 0 && (
        <Card className="mb-5 border-amber-300">
          <CardHeader title={`Quarantined text (${r.injection.length})`} description="These lines look like instructions aimed at an AI, or use disguised letters. They were not read for any value and are never sent to a model." />
          <ul className="divide-y divide-line">
            {r.injection.slice(0, MAX_ROWS).map((q, i) => (
              <li key={i} className="px-5 py-3 text-[13px]">
                <Badge tone="warn" icon="shield">Quarantined</Badge> <span className="text-muted">{src(q)}:</span> <span className="font-mono text-ink">{q.quote}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Classification" description={r.documentType.ambiguous ? "Ambiguous between candidates." : `Decided by ${r.documentType.decidedBy}.`} />
          <Rows rows={r.documentType.reasons.map((x) => ({ label: "Why", value: x.text, source: x.source }))} />
          {r.documentType.candidates.length > 1 && (
            <p className="px-5 pb-4 text-[12px] text-muted">Candidates: {r.documentType.candidates.map((c) => `${TYPE_LABEL[c.type] ?? c.type} (${c.score})`).join(", ")}</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Parties" />
          <Rows rows={r.parties.map((p) => ({ label: p.value.role ?? "Party", value: p.value.name, source: p.source }))} />
        </Card>
        <Card>
          <CardHeader title="Dates" />
          <Rows rows={r.dates.map((d) => ({ label: d.value.kind, value: d.value.iso, source: d.source }))} />
        </Card>
        <Card>
          <CardHeader title="Amounts" />
          <Rows rows={r.amounts.map((a) => ({ label: a.value.label.replace(/_/g, " "), value: `${a.value.currency} ${a.value.amount.toLocaleString("en-US")}`, source: a.source }))} />
        </Card>
        <Card>
          <CardHeader title="Governing law and signatures" />
          <Rows rows={[
            ...r.governingLaw.map((g) => ({ label: "Governing law", value: g.value, source: g.source })),
            ...r.signatureBlocks.map((b) => ({ label: b.value.style === "conformed" ? "Signed (/s/)" : "Signature block", value: b.value.label, source: b.source })),
          ]} />
        </Card>
        <Card>
          <CardHeader title="Conflicts, missing values and warnings" />
          <Rows rows={[
            ...r.conflicts.map((c) => ({ label: `Conflict: ${c.field}`, value: c.values.map((v) => v.value).join(" vs ") })),
            ...r.missing.map((m) => ({ label: "Missing", value: m })),
            ...r.warnings.map((w) => ({ label: "Warning", value: w })),
          ]} />
        </Card>
      </div>
    </>
  );
}
