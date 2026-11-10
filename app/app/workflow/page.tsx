import { requireAdmin } from "@/lib/auth";
import { workflowEvents } from "@/lib/intake/service";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, timeAgo } from "@/components/ui";

export const metadata = { title: "Workflow events" };

const LABEL: Record<string, string> = {
  "intake.completed": "Document read",
  "intake.prepare.requested": "Ready to prepare",
  "intake.review_task.created": "Review task",
  "studio.draft.submitted": "Draft submitted",
  "studio.draft.approved": "Draft approved",
  "studio.draft.changes_requested": "Changes requested",
  "studio.draft.published": "Draft published",
};

// ids and counts only: payloads carry no document text
const summary = (p: unknown) => {
  const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  const keep = ["documentType", "decision", "intakeId", "fileId", "draftId", "version", "conflicts", "missing", "warnings", "quarantined"];
  return keep.filter((k) => o[k] !== undefined && (typeof o[k] === "string" || typeof o[k] === "number")).map((k) => `${k}: ${String(o[k])}`).join(" · ");
};

export default async function Page() {
  const s = await requireAdmin();
  const r = workflowEvents(s);
  const events = r.ok ? r.events : [];
  return (
    <>
      <PageHeader title="Workflow events" sub="What happened in Document Intelligence and Agreement Studio, recorded per workspace." actions={<Badge tone="neutral">Delivery disabled</Badge>} />
      <div className="mb-5"><Notice tone="info">External webhook delivery is disabled on this server: events are recorded here only and are never sent anywhere.</Notice></div>
      <Card>
        <CardHeader title="Events" description="Newest first." />
        {events.length === 0 ? (
          <EmptyState icon="spark" title="No events yet" className="py-10">Read a document, or submit a draft in Agreement Studio.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium text-ink">{LABEL[e.type] ?? e.type} <span className="font-mono text-[12px] text-muted">{e.type}</span></span>
                  <span className="block truncate text-[12px] text-muted">{summary(e.payload)} · {timeAgo(new Date(e.createdAt).toISOString())}</span>
                </span>
                <Badge tone="neutral">{e.delivery === "disabled" ? "delivery disabled" : e.delivery}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
