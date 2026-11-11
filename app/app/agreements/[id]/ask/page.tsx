import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { getTemplateVersion } from "@/lib/templates";
import { assistantMode, conversation, conversations, QA_DAILY } from "@/lib/qa/store";
import { askAction } from "@/app/qa-actions";
import { Notice, timeAgo } from "@/components/ui";
import { EMAIL_HELP } from "@/lib/email-guidance";
import { QaTurn as Turn } from "@/components/qa/QaTurn";
import { AskComposer } from "@/components/qa/AskComposer";

export const metadata = { title: "Ask about this agreement" };

const ERRORS: Record<string, string> = {
  question: "Ask a question of up to 500 characters.",
  slow: "You're asking quickly. Wait a minute and try again.",
  limit: `This workspace has reached today's question limit (${QA_DAILY.model} with the AI assistant, ${QA_DAILY.passages} without). Try again tomorrow.`,
  notfound: "This agreement version wasn't found.",
  thread: "That conversation wasn't found, or it isn't yours to continue. Start a new one.",
  changed: "The stored agreement doesn't match its fingerprint, so it wasn't read.",
  unreadable: "We couldn't read the text in this agreement.",
  failed: "Something went wrong. Try again.",
};
const EXAMPLES = [
  "What are the payment terms?",
  "Can the client end the agreement early, and what would it cost?",
  "If an invoice is paid 30 days late, what does the client owe?",
  "What does each party have to do?",
  "Is anything missing or unclear?",
];
const THREAD_ID = /^qa_[A-Za-z0-9_-]{6,50}$/;

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; q?: string; thread?: string }> }) {
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
  const mode = assistantMode(undefined, s.workspaceId);
  const ai = mode.kind === "model";
  const threadId = q.thread && THREAD_ID.test(q.thread) ? q.thread : undefined;
  const turns = threadId ? conversation(s.workspaceId, version.id, threadId) : [];
  const mine = turns.length > 0 && turns[0].askedBy === s.userEmail;
  const others = conversations(s.workspaceId, version.id).filter((t) => t.id !== threadId);

  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/agreements" className="hover:text-ink">Agreements</Link> / <Link href={`/app/agreements/${version.id}`} className="hover:text-ink">{template.name} v{version.version}</Link> / Ask
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Ask about this agreement</h1>
      <p className="mt-1 mb-4 max-w-3xl text-sm text-muted">
        {ai ? (
          <>Claude reads <span className="text-ink-2">{version.source_name}</span> and answers in plain English, quoting the passages it relies on. Before you see an answer, it&apos;s checked twice. AgreementOS checks it against the agreement: quotes must be exact, figures, dates and names must be in it, parties must do what the agreement gives them, and arithmetic is re-done. Then a second, independent Claude check judges every claim against the whole agreement, with quoted evidence. Answers with a claim that isn&apos;t supported are withheld, and the passages are shown instead. Still read the sources; this isn&apos;t legal advice.</>
        ) : mode.kind === "locked" ? (
          <>Answers come only from <span className="text-ink-2">{version.source_name}</span> and quote the passages they rely on, with page numbers. {mode.canConfirm ? `AI answers start once the workspace owner confirms their email address; until then you'll see the most relevant passages, quoted as written. ${EMAIL_HELP.verify} ${EMAIL_HELP.resendAbove}` : "AI answers need a confirmed email address, and this server can't send confirmation emails yet, so you'll see the most relevant passages, quoted as written."} Not legal advice.</>
        ) : (
          <>Answers come only from <span className="text-ink-2">{version.source_name}</span> and quote the passages they rely on, with page numbers. AI answers are off on this server: you&apos;ll see the most relevant passages, quoted as written. Not legal advice.</>
        )}{" "}
        <Link href={`/app/agreements/${version.id}/understand`} className="text-brand underline underline-offset-2">What it says</Link>
      </p>

      {q.error && <div className="mb-4"><Notice tone="error">{Object.hasOwn(ERRORS, q.error) ? ERRORS[q.error] : ERRORS.failed}</Notice></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <section aria-labelledby="conversation">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="conversation" className="text-base font-semibold">{turns.length ? "Conversation" : "New conversation"}</h2>
            {turns.length > 0 && <Link href={`/app/agreements/${version.id}/ask`} className="text-sm text-brand underline underline-offset-2">Start a new conversation</Link>}
          </div>
          {turns.length > 0 ? (
            <ol aria-label="Conversation" className="mb-4 space-y-5">{turns.map((h) => <Turn key={h.id} h={h} />)}</ol>
          ) : (
            <nav aria-label="Example questions" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-muted">Try an example:</span>
              {EXAMPLES.map((e) => (
                <Link key={e} href={`?q=${encodeURIComponent(e)}`} className="rounded-full border border-line bg-white px-2.5 py-1 text-muted hover:border-line-strong hover:text-ink">{e}</Link>
              ))}
            </nav>
          )}
          {turns.length === 0 || mine ? (
            <AskComposer action={askAction} versionId={version.id} threadId={mine ? threadId : undefined} defaultQuestion={turns.length ? "" : (q.q?.slice(0, 500) ?? "")} ai={ai} />
          ) : (
            <p className="text-sm text-muted">This is {turns[0].askedBy}&apos;s conversation. <Link href={`/app/agreements/${version.id}/ask`} className="text-brand underline underline-offset-2">Start your own</Link> to ask a follow-up.</p>
          )}
        </section>

        <aside aria-labelledby="earlier">
          <h2 id="earlier" className="mb-2 text-base font-semibold">Earlier conversations</h2>
          {others.length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <ul aria-label="Earlier conversations" className="space-y-1.5">
              {others.map((t) => (
                <li key={t.id}>
                  <Link href={`?thread=${t.id}`} className="block rounded-lg border border-line bg-white px-3 py-2 text-sm hover:border-line-strong">
                    <span className="line-clamp-2 break-words text-ink">{t.firstQuestion}</span>
                    <span className="mt-0.5 block text-xs text-muted">{t.turns} {t.turns === 1 ? "question" : "questions"} · {t.askedBy} · {timeAgo(t.lastAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
