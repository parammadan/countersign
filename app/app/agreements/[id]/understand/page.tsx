import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { getTemplateVersion } from "@/lib/templates";
import { latestAnalysis } from "@/lib/understand/store";
import { CATEGORIES, CATEGORY_LABEL, STATUS_LABEL, type Finding, type Status } from "@/lib/understand/schema";
import { analyzeAgreementAction, reviewFindingAction } from "@/app/understand-actions";
import { Badge, Button, Card, EmptyState, Notice, timeAgo } from "@/components/ui";
import { fmtDay } from "@/lib/time";

export const metadata = { title: "What this agreement says" };

const ERRORS: Record<string, string> = {
  limit: "This workspace has read 20 agreements in the last hour, the current limit. Try again later.",
  notfound: "That suggestion no longer exists. The agreement may have been read again.",
  changed: "The stored agreement doesn't match its fingerprint, so it wasn't read.",
  stale: "This agreement was read again since you opened the page. Review the new results.",
  toolong: "This agreement has more than 200 pages, more than we read.",
  unreadable: "We couldn't read the text in this agreement.",
  failed: "Something went wrong. Try again.",
};

const STATUS_TONE: Record<Status, "ok" | "warn" | "neutral" | "bad"> = { stated: "ok", inferred: "warn", missing: "neutral", ambiguous: "warn" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; read?: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const q = await searchParams;
  let tv;
  try {
    tv = getTemplateVersion(s.workspaceId, id);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { template, version } = tv;
  const admin = s.role !== "staff";
  const view = latestAnalysis(s.workspaceId, version.id);
  const confirmed = view ? view.result.findings.filter((f) => view.reviews[f.id]?.decision === "confirmed") : [];

  const readForm = (label: string, variant: "primary" | "secondary") => (
    <form action={analyzeAgreementAction}>
      <input type="hidden" name="versionId" value={version.id} />
      <Button variant={variant} icon="spark">{label}</Button>
    </form>
  );

  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/agreements" className="hover:text-ink">Agreements</Link> / <Link href={`/app/agreements/${version.id}`} className="hover:text-ink">{template.name} v{version.version}</Link> / What it says
      </div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">What this agreement says</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Suggestions from reading <span className="text-ink-2">{version.source_name}</span>, each with the text it&apos;s based on. They&apos;re not legal advice and can be wrong: confirm what&apos;s right and dismiss what isn&apos;t. Nothing here changes the agreement or its fields.
          </p>
        </div>
        {admin && view && <div className="shrink-0">{readForm("Read again", "secondary")}</div>}
      </div>

      {q.error && <div className="mb-4"><Notice tone="error">{Object.hasOwn(ERRORS, q.error) ? ERRORS[q.error] : ERRORS.failed}</Notice></div>}

      {!view ? (
        <Card className="p-6">
          <EmptyState icon="agreement" title="Not read yet" action={admin ? readForm("Read this agreement", "primary") : undefined}>
            {admin
              ? "AgreementOS reads the agreement and lists the parties, type, dates, payment terms, key clauses, signature requirements and anything missing or unclear, quoting the text for each."
              : "An admin can read this agreement to list its parties, dates, payment terms and more."}
          </EmptyState>
        </Card>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            Read {timeAgo(view.createdAt)} by {view.createdBy} · {view.result.pages} page{view.result.pages === 1 ? "" : "s"} · {view.result.analyzer.kind === "rules" ? "built-in reading rules (no AI model; the document didn't leave AgreementOS)" : `${view.result.analyzer.name}`}
          </p>
          {view.result.warnings.length > 0 && (
            <div className="mb-4">
              <Notice tone="warn">
                <ul className="list-disc pl-4">{view.result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </Notice>
            </div>
          )}

          <section aria-labelledby="verified" className="mb-6">
            <h2 id="verified" className="mb-2 text-base font-semibold">Confirmed by your team</h2>
            {confirmed.length ? (
              <ul aria-label="Confirmed facts" className="divide-y divide-line rounded-lg border border-line bg-white">
                {confirmed.map((f) => (
                  <li key={f.id} className="flex flex-wrap gap-x-2 px-4 py-2 text-sm">
                    <span className="font-medium">{f.label}:</span>
                    <span>{f.value ?? STATUS_LABEL[f.status]}</span>
                    <span className="text-muted">· {view.reviews[f.id].by}, {fmtDay(view.reviews[f.id].at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing confirmed yet. Everything below is a suggestion until someone confirms it.</p>
            )}
          </section>

          {CATEGORIES.map((c) => {
            const list = view.result.findings.filter((f) => f.category === c);
            if (!list.length) return null;
            return (
              <section key={c} aria-labelledby={`cat-${c}`} className="mb-6">
                <h2 id={`cat-${c}`} className="mb-2 text-base font-semibold">{CATEGORY_LABEL[c]}</h2>
                <ul aria-label={CATEGORY_LABEL[c]} className="divide-y divide-line rounded-lg border border-line bg-white">
                  {list.map((f) => (
                    <FindingRow key={f.id} f={f} review={view.reviews[f.id]} admin={admin} analysisId={view.id} versionId={version.id} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}

function FindingRow({ f, review, admin, analysisId, versionId }: { f: Finding; review?: { decision: string; by: string; at: string }; admin: boolean; analysisId: string; versionId: string }) {
  const decide = (decision: string, label: string, variant: "secondary" | "ghost") => (
    <form action={reviewFindingAction}>
      <input type="hidden" name="analysisId" value={analysisId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="findingId" value={f.id} />
      <input type="hidden" name="decision" value={decision} />
      <Button size="sm" variant={variant} aria-label={`${label}: ${f.label}`}>{label}</Button>
    </form>
  );
  return (
    <li id={f.id} className={review?.decision === "dismissed" ? "px-4 py-3 opacity-60" : "px-4 py-3"}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{f.label}</span>
            <Badge tone={STATUS_TONE[f.status]}>{STATUS_LABEL[f.status]}</Badge>
            {review && <Badge tone={review.decision === "confirmed" ? "brand" : "neutral"} icon={review.decision === "confirmed" ? "check" : "x"}>{review.decision === "confirmed" ? "Confirmed" : "Dismissed"} by {review.by}</Badge>}
          </div>
          {f.value && <p className="mt-1 text-sm break-words">{f.value}</p>}
          {f.note && <p className="mt-1 text-xs text-muted">{f.note}</p>}
          {f.evidence.map((e, i) => (
            <figure key={i} className="mt-2 border-l-2 border-line-strong pl-3 text-xs text-ink-2">
              <blockquote className="break-words">“{e.quote}”</blockquote>
              <figcaption className="text-muted">Page {e.page}</figcaption>
            </figure>
          ))}
        </div>
        {admin && (
          <div className="flex shrink-0 gap-1.5">
            {review ? decide("undo", "Undo", "ghost") : <>{decide("confirmed", "Confirm", "secondary")}{decide("dismissed", "Dismiss", "ghost")}</>}
          </div>
        )}
      </div>
    </li>
  );
}
