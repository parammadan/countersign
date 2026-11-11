import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { intakePrefill } from "@/lib/intake/service";
import { kindSpecs } from "@/lib/drafts/service";
import { Notice, PageHeader } from "@/components/ui";
import { DraftFromIntake } from "@/components/intake/DraftFromIntake";
import { aiOnlyValues, reasonText } from "@/components/intake/labels";

export const metadata = { title: "Start a draft" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const g = intakePrefill(s, id);
  if (!g.ok) notFound();
  const name = g.result.filename ?? "Pasted text";
  const p = g.prefill;
  const rec = g.result.record;
  const aiOnly = aiOnlyValues(p.ai);
  return (
    <>
      <div className="mb-3 text-sm text-muted">
        <Link href="/app/documents" className="hover:text-ink">Document Intelligence</Link> / <Link href={`/app/documents/${g.result.id}`} className="hover:text-ink">{name}</Link> / Start a draft
      </div>
      <PageHeader title="Start a draft" sub="Agreement Studio, with only the values this document states filled in. Nothing is published or sent automatically: a person always reviews and approves the draft first." />
      {rec.routing.decision === "needs_review" && (
        <div className="mb-5">
          <Notice tone="warn">
            This document needs review. Resolve these against the document before you rely on any value:
            <ul className="mt-1 list-disc pl-5">{rec.routing.reasons.map((x) => <li key={x}>{reasonText(x)}</li>)}</ul>
          </Notice>
        </div>
      )}
      {aiOnly.length > 0 && (
        <div className="mb-5">
          <Notice tone="info">
            Claude&apos;s analysis of this document added {aiOnly.length} value{aiOnly.length === 1 ? "" : "s"} the rules didn&apos;t read, each copied exactly from its quote. Check {aiOnly.length === 1 ? "it" : "each one"} below:
            <ul className="mt-1 space-y-1 text-[13px]">
              {aiOnly.map((x) => (
                <li key={x.key} className="break-words">
                  <span className="text-muted">{x.label}:</span> <span className="font-medium">{x.value}</span>
                  {x.source && <span className="text-muted"> (p. {x.source.page}: “{x.source.quote}”)</span>}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}
      <DraftFromIntake intakeId={g.result.id} kinds={kindSpecs()} initial={{ kind: p.kind, names: p.names, terms: p.terms as Record<string, string>, notes: p.notes, ...(p.ai && { ai: { names: p.ai.names, terms: p.ai.terms as Record<string, string> } }), ...(p.clarifications && { clarifications: p.clarifications }) }} />
    </>
  );
}
