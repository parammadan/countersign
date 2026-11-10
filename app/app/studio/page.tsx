import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { kindSpecs, listDrafts, studioAiState } from "@/lib/drafts/service";
import { Badge, Card, CardHeader, EmptyState, PageHeader, timeAgo } from "@/components/ui";
import { NewAgreement } from "@/components/studio/NewAgreement";
import { aiBadge } from "@/components/studio/ai-state";

export const metadata = { title: "Agreement Studio" };

const STATUS = { draft: "Draft", pending_approval: "Waiting for approval", approved: "Approved", publishing: "Publishing", published: "Published" } as const;

export default async function Page() {
  const s = await requireSession();
  const list = listDrafts(s);
  const drafts = list.ok ? list.drafts : [];
  // shown up front so controls that would only fail are hidden; each AI step is still gated on the server when it runs
  const ai = studioAiState(s);
  const badge = aiBadge(ai);
  return (
    <>
      <PageHeader
        title="Agreement Studio"
        sub="Draft an agreement from a description, edit it clause by clause, get it approved, then publish it to Agreements for signing."
        actions={<Badge tone={badge.tone} icon="spark">{badge.text}</Badge>}
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <NewAgreement kinds={kindSpecs()} ai={ai} />
        <Card>
          <CardHeader title="Drafts" description="Every draft in this workspace." />
          {drafts.length === 0 ? (
            <EmptyState icon="agreement" title="No drafts yet" className="py-10">Generate one with the form.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link href={`/app/studio/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-subtle">
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">{d.title}</span>
                      <span className="text-[12px] text-muted">{d.kind} · {timeAgo(d.updated_at)}</span>
                    </span>
                    <Badge tone={d.status === "published" || d.status === "approved" ? "ok" : d.status === "pending_approval" ? "warn" : "neutral"}>{STATUS[d.status]}</Badge>
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
