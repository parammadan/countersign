import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { listIntakes } from "@/lib/intake/service";
import { Badge, Card, CardHeader, EmptyState, PageHeader, timeAgo } from "@/components/ui";
import { ReadDocument } from "@/components/intake/ReadDocument";
import { DECISION_LABEL, DECISION_TONE, TYPE_LABEL } from "@/components/intake/labels";

export const metadata = { title: "Document Intelligence" };

export default async function Page() {
  const s = await requireSession();
  const r = listIntakes(s);
  const results = r.ok ? r.results : [];
  return (
    <>
      <PageHeader title="Document Intelligence" sub="Read an incoming document, see what it is and what it says, and start a draft from it when it's ready." actions={<Badge tone="neutral">Rules only: no AI</Badge>} />
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <ReadDocument />
        <Card>
          <CardHeader title="Read documents" description="Every document read in this workspace." />
          {results.length === 0 ? (
            <EmptyState icon="files" title="Nothing read yet" className="py-10">Upload or paste a document.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {results.map((d) => (
                <li key={d.id}>
                  <Link href={`/app/documents/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-subtle">
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">{d.filename ?? (d.source === "paste" ? "Pasted text" : "Document")}</span>
                      <span className="text-[12px] text-muted">{TYPE_LABEL[d.doc_type] ?? d.doc_type} · {timeAgo(d.created_at)}</span>
                    </span>
                    <Badge tone={DECISION_TONE[d.decision]}>{DECISION_LABEL[d.decision]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
