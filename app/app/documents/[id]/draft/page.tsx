import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { intakePrefill } from "@/lib/intake/service";
import { kindSpecs } from "@/lib/drafts/service";
import { PageHeader } from "@/components/ui";
import { DraftFromIntake } from "@/components/intake/DraftFromIntake";

export const metadata = { title: "Start a draft" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const g = intakePrefill(s, id);
  if (!g.ok) notFound();
  const name = g.result.filename ?? "Pasted text";
  const p = g.prefill;
  return (
    <>
      <div className="mb-3 text-sm text-muted">
        <Link href="/app/documents" className="hover:text-ink">Document Intelligence</Link> / <Link href={`/app/documents/${g.result.id}`} className="hover:text-ink">{name}</Link> / Start a draft
      </div>
      <PageHeader title="Start a draft" sub="Agreement Studio, with only the values this document states filled in. A person always reviews and approves the draft before anything is sent." />
      <DraftFromIntake kinds={kindSpecs()} initial={{ kind: p.kind, names: p.names, terms: p.terms as Record<string, string>, notes: p.notes }} />
    </>
  );
}
