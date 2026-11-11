import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { intakePrefill } from "@/lib/intake/service";
import { kindSpecs } from "@/lib/drafts/service";
import { Notice, PageHeader } from "@/components/ui";
import { DraftFromIntake } from "@/components/intake/DraftFromIntake";

export const metadata = { title: "Start a draft" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const g = intakePrefill(s, id);
  if (!g.ok) notFound();
  const name = g.result.filename ?? "Pasted text";
  const p = g.prefill;
  const rec = g.result.record;
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
            <ul className="mt-1 list-disc pl-5">{rec.routing.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          </Notice>
        </div>
      )}
      {p.ai && (
        <div className="mb-5">
          <Notice tone="info">
            Claude&apos;s analysis of this document added {Object.keys(p.ai.names).length + Object.keys(p.ai.terms).length} value{Object.keys(p.ai.names).length + Object.keys(p.ai.terms).length === 1 ? "" : "s"} the rules didn&apos;t read, each copied exactly from its quote:
            {p.ai.sources.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[13px]">
                {p.ai.sources.filter((x) => (x.key.startsWith("role:") ? Object.values(p.ai!.names).includes(x.value) : Object.hasOwn(p.ai!.terms, x.key.slice(5)))).map((x, i) => (
                  <li key={`${x.key}-${i}`}><span className="font-medium">{x.value}</span> <span className="text-muted">p. {x.page}: “{x.quote}”</span></li>
                ))}
              </ul>
            )}
          </Notice>
        </div>
      )}
      <DraftFromIntake intakeId={g.result.id} kinds={kindSpecs()} initial={{ kind: p.kind, names: p.names, terms: p.terms as Record<string, string>, notes: p.notes, ...(p.ai && { ai: { names: p.ai.names, terms: p.ai.terms as Record<string, string> } }), ...(p.clarifications && { clarifications: p.clarifications }) }} />
    </>
  );
}
