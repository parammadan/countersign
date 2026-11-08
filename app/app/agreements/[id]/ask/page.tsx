import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { getTemplateVersion } from "@/lib/templates";
import { assistantMode, QA_DAILY, recentAnswers } from "@/lib/qa/store";
import { QA_STATUS_LABEL, type QaStatus } from "@/lib/qa/answer";
import { askAction } from "@/app/qa-actions";
import { Badge, Button, Notice, inputCls, timeAgo } from "@/components/ui";

export const metadata = { title: "Ask about this agreement" };

const ERRORS: Record<string, string> = {
  question: "Ask a question of up to 500 characters.",
  slow: "You're asking quickly. Wait a minute and try again.",
  limit: `This workspace has reached today's question limit (${QA_DAILY.model} with the AI assistant, ${QA_DAILY.passages} without). Try again tomorrow.`,
  notfound: "This agreement version wasn't found.",
  changed: "The stored agreement doesn't match its fingerprint, so it wasn't read.",
  unreadable: "We couldn't read the text in this agreement.",
  failed: "Something went wrong. Try again.",
};
const TONE: Record<QaStatus, "ok" | "warn" | "neutral"> = { answered: "ok", partial: "warn", not_found: "neutral" };
const EXAMPLES = ["What are the payment terms?", "Can the client end the agreement early?", "What does each party have to do?", "Is anything missing or unclear?"];

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; q?: string; asked?: string }> }) {
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
  const history = recentAnswers(s.workspaceId, version.id);
  const mode = assistantMode();

  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/agreements" className="hover:text-ink">Agreements</Link> / <Link href={`/app/agreements/${version.id}`} className="hover:text-ink">{template.name} v{version.version}</Link> / Ask
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Ask about this agreement</h1>
      <p className="mt-1 mb-4 max-w-2xl text-sm text-muted">
        Answers come only from <span className="text-ink-2">{version.source_name}</span> and quote the passages they rely on, with page numbers. If the agreement doesn&apos;t say, you&apos;re told so. Not legal advice; check the quotes.{" "}
        <Link href={`/app/agreements/${version.id}/understand`} className="text-brand underline underline-offset-2">What it says</Link>
      </p>

      {q.error && <div className="mb-4"><Notice tone="error">{Object.hasOwn(ERRORS, q.error) ? ERRORS[q.error] : ERRORS.failed}</Notice></div>}

      <form action={askAction} className="mb-2 rounded-lg border border-line bg-white p-4">
        <input type="hidden" name="versionId" value={version.id} />
        <label htmlFor="question" className="mb-1 block text-sm font-medium">Your question</label>
        <textarea id="question" name="question" required minLength={3} maxLength={500} rows={2} defaultValue={q.q?.slice(0, 500) ?? ""} placeholder="e.g. Can the client end the agreement early?" className={inputCls + " h-auto py-2"} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {mode.kind === "model" ? `Answered by an AI assistant (${mode.model}) from the agreement's text, then checked against it.` : "AI answers are off on this server: you'll see the most relevant passages and what AgreementOS found, quoted as written."}
          </p>
          <Button icon="spark">Ask</Button>
        </div>
      </form>
      <nav aria-label="Example questions" className="mb-6 flex flex-wrap gap-1.5 text-xs">
        {EXAMPLES.map((e) => (
          <Link key={e} href={`?q=${encodeURIComponent(e)}`} className="rounded-full border border-line bg-white px-2.5 py-0.5 text-muted hover:text-ink">{e}</Link>
        ))}
      </nav>

      <section aria-labelledby="answers">
        <h2 id="answers" className="mb-2 text-base font-semibold">Answers</h2>
        {!history.length ? (
          <p className="text-sm text-muted">No questions yet.</p>
        ) : (
          <ol aria-label="Answers" className="space-y-3">
            {history.map((h) => (
              <li key={h.id} id={h.id} className="rounded-lg border border-line bg-white p-4">
                <p className="font-medium break-words">{h.question}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone={TONE[h.result.status]}>{QA_STATUS_LABEL[h.result.status]}</Badge>
                  <span>{h.result.mode === "model" ? `AI assistant (${h.result.model})` : "Passages, no AI model"} · {h.askedBy} · {timeAgo(h.createdAt)}</span>
                </div>
                <p className="mt-2 text-sm whitespace-pre-line break-words">{h.result.answer}</p>
                {h.result.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs text-warn">{h.result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                )}
                {h.result.citations.map((c, i) => (
                  <figure key={i} className="mt-2 border-l-2 border-line-strong pl-3 text-xs text-ink-2">
                    <blockquote className="break-words">“{c.quote}”</blockquote>
                    <figcaption className="text-muted">Page {c.page}</figcaption>
                  </figure>
                ))}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
