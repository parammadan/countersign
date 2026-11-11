import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { listIntakes } from "@/lib/intake/service";
import { documentAiState } from "@/lib/intake/ai-service";
import { verificationRequired } from "@/lib/emailverify";
import { EMAIL_HELP } from "@/lib/email-guidance";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, timeAgo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ReadDocument } from "@/components/intake/ReadDocument";
import { DECISION_LABEL, DECISION_TONE, TYPE_LABEL } from "@/components/intake/labels";
import { DOC_AI_COPY as C, DOC_AI_UNAVAILABLE } from "@/components/intake/ai-copy";

export const metadata = { title: "Document Intelligence" };

export default async function Page() {
  const s = await requireSession();
  const r = listIntakes(s);
  const results = r.ok ? r.results : [];
  // no model call: whether AI would run for this workspace now
  const ai = documentAiState(s);
  return (
    <>
      <PageHeader
        eyebrow="Document Intelligence"
        title={C.heading}
        sub={C.intro}
        actions={
          ai.available ? <Badge tone="ok" icon="spark">AI on</Badge> : <Badge tone={ai.reason === "off" ? "neutral" : "warn"}>{ai.reason === "off" ? "AI off: rules only" : "AI paused: rules only"}</Badge>
        }
      />
      <p className="-mt-4 mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
        <Icon name="info" size={14} className="shrink-0" />
        <span>{C.scope}</span>
        <Link href="/app/knowledge" className="text-brand underline underline-offset-2">Open the Knowledge Hub</Link>
      </p>
      {!ai.available && (
        <div className="mb-5">
          <Notice tone={ai.reason === "off" ? "info" : "warn"}>
            {DOC_AI_UNAVAILABLE[ai.reason]}
            {ai.reason === "unverified" && verificationRequired() && <span className="mt-1 block text-[13px]">{EMAIL_HELP.verify} {EMAIL_HELP.resendAbove}</span>}
          </Notice>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <ReadDocument aiOn={ai.available} />
          <p className="text-xs text-muted">{C.disclaimer}. Claude explains what the document says and quotes where; check every point against the document.</p>
        </div>
        <Card className="self-start">
          <CardHeader title="Your documents" description="Every document read in this workspace." />
          {results.length === 0 ? (
            <EmptyState icon="files" title={C.emptyTitle} className="py-10">{C.empty}</EmptyState>
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
