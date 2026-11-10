import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { assistantMode, indexStatus, M3_DAILY, recentQuestions } from "@/lib/m3/store";
import type { M3Citation, M3Status } from "@/lib/m3/answer";
import { askAgreementsAction, indexAgreementsAction } from "@/app/knowledge-actions";
import { Badge, Button, EmptyState, Notice, PageHeader, inputCls, timeAgo } from "@/components/ui";

export const metadata = { title: "Knowledge Hub" };

const ERRORS: Record<string, string> = {
  question: "Ask a question of up to 500 characters.",
  slow: "You're asking quickly. Wait a minute and try again.",
  limit: `This workspace has reached today's question limit (${M3_DAILY.model} with the AI assistant, ${M3_DAILY.passages} without). Try again tomorrow.`,
  indexslow: "Indexing was just run. Wait a minute and try again.",
  failed: "Something went wrong. Try again.",
};
const STATUS: Record<M3Status, { label: string; tone: "ok" | "warn" | "neutral" }> = {
  answered: { label: "Answered from your agreements", tone: "ok" },
  partial: { label: "Passages to read", tone: "warn" },
  not_found: { label: "Not found in your agreements", tone: "neutral" },
};
const EXAMPLES = ["Which agreements allow early termination?", "When are invoices due?", "What is the liability cap?", "Who owns the work product?"];
const num = (v: string | undefined) => (v && /^\d{1,4}$/.test(v) ? Number(v) : 0);

function Quote({ c, flagged }: { c: M3Citation; flagged?: boolean }) {
  // the whole passage, with the quoted part highlighted, so a fragment can't hide its context
  const at = c.context.indexOf(c.quote);
  return (
    <figure className={"mt-2 border-l-2 pl-3 text-xs text-ink-2 " + (flagged ? "border-amber-300" : "border-line-strong")}>
      <blockquote className="break-words">
        <span className="mr-1 font-semibold text-ink">[{flagged ? `F${c.n}` : c.n}]</span>
        {at >= 0 ? (
          <>“{c.context.slice(0, at)}<mark className="rounded bg-brand-soft px-0.5 text-ink">{c.quote}</mark>{c.context.slice(at + c.quote.length)}”</>
        ) : (
          <>“{c.quote}”</>
        )}
      </blockquote>
      <figcaption className="mt-0.5 text-muted">
        <Link href={`/app/agreements/${encodeURIComponent(c.versionId)}`} className="text-brand underline underline-offset-2">{c.agreement}</Link>
        {" · "}
        <a href={`/api/versions/${encodeURIComponent(c.versionId)}/pdf#page=${c.page}`} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">page {c.page}</a>
      </figcaption>
    </figure>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; q?: string; asked?: string; indexed?: string; unchanged?: string; removed?: string; failed?: string }> }) {
  const s = await requireSession();
  const q = await searchParams;
  const status = indexStatus(s.workspaceId);
  const history = recentQuestions(s.workspaceId);
  const mode = assistantMode();
  const ran = q.indexed !== undefined;

  return (
    <>
      <PageHeader
        title="Knowledge Hub"
        sub={
          <>
            Ask a question across all of this workspace&apos;s agreements. Answers quote the passages they rely on, with the agreement and page. If your agreements don&apos;t support an answer, you&apos;re told so and nothing is quoted. Read the passages: an answer can still put them together wrongly. Not legal advice.
          </>
        }
      />

      {q.error && <div className="mb-4"><Notice tone="error">{Object.hasOwn(ERRORS, q.error) ? ERRORS[q.error] : ERRORS.failed}</Notice></div>}
      {ran && (
        <div className="mb-4">
          <Notice tone={num(q.failed) ? "warn" : "ok"}>
            Indexed {num(q.indexed)} agreement{num(q.indexed) === 1 ? "" : "s"}, {num(q.unchanged)} already up to date{num(q.removed) ? `, ${num(q.removed)} removed` : ""}.
            {num(q.failed) > 0 && ` ${num(q.failed)} couldn't be read and won't be searched until they can.`}
          </Notice>
        </div>
      )}

      <section aria-labelledby="index" className="mb-6 rounded-lg border border-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="index" className="text-base font-semibold">Indexed agreements</h2>
            <p className="text-sm text-muted">
              {status.indexed} of {status.total} agreement{status.total === 1 ? "" : "s"} indexed. Each agreement is searched at its published version (or its newest draft if none is published).
            </p>
          </div>
          <form action={indexAgreementsAction}>
            <Button icon="upload" variant="secondary">Index agreements</Button>
          </form>
        </div>
        {status.total === 0 ? (
          <EmptyState icon="agreement" title="No agreements yet" className="py-6">
            Upload an agreement on the <Link href="/app/agreements" className="text-brand underline underline-offset-2">Agreements</Link> page, then index it here.
          </EmptyState>
        ) : (
          <ul aria-label="Agreements" className="mt-3 divide-y divide-line text-sm">
            {status.agreements.map((a) => (
              <li key={a.templateId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-words">
                  <Link href={`/app/agreements/${encodeURIComponent(a.versionId)}`} className="font-medium hover:underline">{a.name}</Link> <span className="text-muted">v{a.version}</span>
                </span>
                <span className="flex items-center gap-2">
                  {a.indexed ? <Badge tone="ok">Indexed {timeAgo(a.indexedAt)}</Badge> : <Badge tone="warn">Not indexed</Badge>}
                  <form action={indexAgreementsAction}>
                    <input type="hidden" name="templateId" value={a.templateId} />
                    <Button size="sm" variant="ghost">Re-index</Button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={askAgreementsAction} className="mb-2 rounded-lg border border-line bg-white p-4">
        <label htmlFor="question" className="mb-1 block text-sm font-medium">Your question</label>
        <textarea id="question" name="question" required minLength={3} maxLength={500} rows={2} defaultValue={q.q?.slice(0, 500) ?? ""} placeholder="e.g. Which agreements allow early termination?" className={inputCls + " h-auto py-2"} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            {mode.kind === "model" ? `Answered by an AI assistant (${mode.model}) from the quoted passages only, then checked against them.` : "AI answers are off on this server: you'll see the passages that answer your question, quoted as written."}
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
                  <Badge tone={STATUS[h.result.status].tone}>{STATUS[h.result.status].label}</Badge>
                  <span>{h.result.mode === "model" ? `AI assistant (${h.result.model})` : "Passages, no AI model"} · {h.askedBy} · {timeAgo(h.createdAt)}</span>
                </div>
                <p className="mt-2 text-sm whitespace-pre-line break-words">{h.result.answer}</p>
                {h.result.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs text-warn">{h.result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                )}
                {h.result.citations.map((c) => <Quote key={`c${c.n}`} c={c} />)}
                {h.result.flagged.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-warn">Possibly addressed to an AI or automated reader: check before relying on it</p>
                    {h.result.flagged.map((c) => <Quote key={`f${c.n}`} c={c} flagged />)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
