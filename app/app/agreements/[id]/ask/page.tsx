import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { getTemplateVersion } from "@/lib/templates";
import { assistantMode, conversation, conversations, QA_DAILY, type QaEntry } from "@/lib/qa/store";
import type { Citation } from "@/lib/qa/answer";
import { askAction } from "@/app/qa-actions";
import { Badge, Notice, timeAgo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { qaPresentation } from "@/components/qaPresentation";
import { AskComposer } from "./AskComposer";

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

function locate(context: string, quote: string): { at: number; len: number } | null {
  const exact = context.indexOf(quote);
  if (exact >= 0) return { at: exact, len: quote.length };
  const pattern = quote
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/["“”„]/g, "[\"“”„]")
    .replace(/['‘’]/g, "['‘’]")
    .replace(/[-‐‑‒–—]/g, "[-‐‑‒–—]");
  const m = new RegExp(pattern, "i").exec(context);
  return m ? { at: m.index, len: m[0].length } : null;
}

type Group = { context?: string; quotes: string[]; page: number; added: boolean; passages: string[] };
const FIGURE = "scroll-mt-24 rounded-r target:bg-brand-soft/40 target:ring-2 target:ring-brand/40";
const Num = ({ n }: { n: number }) => <span className="mr-1 font-mono text-[11px] text-muted">[{n}]</span>;

/** One passage with every quote taken from it highlighted, so a fragment can't hide its context. */
function Source({ id, n, context, quotes, page, added }: Group & { id: string; n: number }) {
  if (added && context && !quotes.length) return (
    <figure id={id} className={`${FIGURE} border-l-2 border-dashed border-line-strong pl-3 text-[13px] leading-relaxed text-ink-2`}>
      <blockquote className="break-words"><Num n={n} />“{context}”</blockquote>
      <figcaption className="mt-0.5 text-xs text-muted">Page {page} · added by AgreementOS: the answer also relies on this passage</figcaption>
    </figure>
  );
  if (!context) return (
    <figure id={id} className={`${FIGURE} border-l-2 border-brand/40 pl-3 text-[13px] leading-relaxed text-ink-2`}>
      <blockquote className="break-words"><Num n={n} />{quotes.map((q, i) => <span key={i}>“<mark className="rounded bg-brand-soft px-0.5 text-ink">{q}</mark>” </span>)}</blockquote>
      <figcaption className="mt-0.5 text-xs text-muted">Page {page}</figcaption>
    </figure>
  );
  // non-overlapping spans of the quotes in the passage, in order; matched as the checks match them (any case,
  // straight or curly quotes, any spacing), so the agreement's own words are what's highlighted
  const spans = quotes.map((q) => locate(context, q)).filter((x): x is { at: number; len: number } => x !== null).sort((x, y) => x.at - y.at);
  const parts: { text: string; mark: boolean }[] = [];
  let pos = 0;
  for (const sp of spans) {
    if (sp.at < pos) continue;
    parts.push({ text: context.slice(pos, sp.at), mark: false }, { text: context.slice(sp.at, sp.at + sp.len), mark: true });
    pos = sp.at + sp.len;
  }
  parts.push({ text: context.slice(pos), mark: false });
  const missing = quotes.filter((q) => locate(context, q) === null);
  return (
    <figure id={id} className={`${FIGURE} border-l-2 ${added ? "border-dashed border-line-strong" : "border-brand/40"} pl-3 text-[13px] leading-relaxed text-ink-2`}>
      <blockquote className="break-words">
        <Num n={n} />“{parts.map((p, i) => (p.mark ? <mark key={i} className="rounded bg-brand-soft px-0.5 text-ink">{p.text}</mark> : <span key={i}>{p.text}</span>))}”
        {missing.map((q, i) => <span key={i} className="mt-1 block">Quoted: “{q}”</span>)}
      </blockquote>
      <figcaption className="mt-0.5 text-xs text-muted">Page {page}{added ? " · added by AgreementOS: the answer also relies on this passage" : ""}</figcaption>
    </figure>
  );
}

function sources(cs: Citation[]): Group[] {
  const by = new Map<string, Group>();
  cs.forEach((c, i) => {
    const key = c.context ? `${c.page}:${c.context}` : `q${i}`;
    const g = by.get(key) ?? { context: c.context, quotes: [], page: c.page, added: !!c.added, passages: [] };
    // an attached passage is shown whole, highlighting only a quote the verifier relied on
    if (!c.added || (c.context && c.quote !== c.context)) g.quotes.push(c.quote);
    if (c.passage && !g.passages.includes(c.passage)) g.passages.push(c.passage);
    g.added = g.added && !!c.added;
    by.set(key, g);
  });
  return [...by.values()];
}

const VERDICT_LABEL = { supported: "Supported", contradicted: "Contradicted", unsupported: "Not in the agreement", uncertain: "Uncertain" } as const;

function Turn({ h }: { h: QaEntry }) {
  const r = h.result;
  const ai = r.mode === "model";
  const groups = sources(r.citations);
  const sourceOf = (passage: string) => groups.findIndex((g) => g.passages.includes(passage));
  // badges and wording per outcome: withheld, trimmed, qualified, verified, and the passages-only fallbacks
  const shown = qaPresentation(r);
  return (
    <li id={h.id} className="scroll-mt-20">
      <div className="mb-2 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-soft px-3.5 py-2 text-sm text-ink">
          <p className="break-words">{h.question}</p>
          <p className="mt-0.5 text-right text-[11px] text-muted">{h.askedBy} · {timeAgo(h.createdAt)}</p>
        </div>
      </div>
      <article aria-label={`Answer to: ${h.question}`} className="rounded-lg border border-line bg-white p-4 shadow-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {shown.badges.map((b) => <Badge key={b.label} tone={b.tone} icon={b.icon}>{b.label}</Badge>)}
          <span>{shown.how}</span>
        </div>
        {shown.notice && (
          <div className="mt-2" role="note" aria-label="Why there's no AI answer">
            <Notice tone="warn">{shown.notice}</Notice>
          </div>
        )}
        {ai && r.verification === "qualified" && r.unverified && r.unverified.length > 0 && (
          <div className="mt-2" role="note" aria-label="Verification notice">
            <Notice tone="warn">
              AgreementOS checked this answer&apos;s sources, figures, names and arithmetic against the agreement, but couldn&apos;t confirm everything: {r.unverified.join("; ")}. Read the sources below before relying on it.
            </Notice>
          </div>
        )}
        <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line break-words text-ink">{shown.answer ?? r.answer}</p>
        {r.explanation && (
          <section className="mt-3" aria-label="Why">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Why</h3>
            <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-line break-words text-ink-2">{r.explanation}</p>
          </section>
        )}
        {r.calculations && r.calculations.length > 0 && (
          <section className="mt-3" aria-label="Calculations">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Worked out</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {r.calculations.map((c, i) => (
                <li key={i} className="flex items-center gap-1.5 font-mono text-[13px] text-ink-2">
                  <Icon name="check" size={14} className="text-ok" aria-hidden />
                  <span>{c.expression} = {c.result}</span>
                  <span className="sr-only">(re-checked by AgreementOS)</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {r.notStated && r.notStated.length > 0 && (
          <section className="mt-3" aria-label="Not stated in the agreement">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Not stated in the agreement</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">{r.notStated.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </section>
        )}
        {shown.notes.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-warn" aria-label="Notes">
            {shown.notes.map((w, i) => <li key={i} className="flex gap-1.5"><Icon name="alert" size={14} className="mt-[1px] shrink-0" aria-hidden />{w}</li>)}
          </ul>
        )}
        {ai && r.checks && r.checks.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted uppercase">What was checked ({r.checks.length} {r.checks.length === 1 ? "claim" : "claims"})</summary>
            <ul className="mt-1.5 space-y-1" aria-label="Claims checked against the agreement">
              {r.checks.map((c, i) => (
                <li key={i} className="flex gap-1.5 text-ink-2">
                  <Icon name={c.verdict === "supported" ? "check" : "alert"} size={14} className={`mt-[3px] shrink-0 ${c.verdict === "supported" ? "text-ok" : "text-warn"}`} aria-hidden />
                  <span className="break-words">
                    {c.claim} <span className="text-xs text-muted">({VERDICT_LABEL[c.verdict]}{c.material ? "" : ", minor"})</span>
                    {(c.passages ?? []).map((p) => sourceOf(p)).filter((n, j, all) => n >= 0 && all.indexOf(n) === j).map((n) => (
                      <a key={n} href={`#${h.id}-s${n + 1}`} className="ml-1 font-mono text-[11px] text-brand underline underline-offset-2" aria-label={`Source ${n + 1}, page ${groups[n].page}`}>[{n + 1}]</a>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {groups.length > 0 && (
          <section className="mt-3 border-t border-line pt-3" aria-label="Sources">
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Sources in the agreement</h3>
            <div className="space-y-2">{groups.map((g, i) => <Source key={i} id={`${h.id}-s${i + 1}`} n={i + 1} {...g} />)}</div>
          </section>
        )}
      </article>
    </li>
  );
}

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
          <>Answers come only from <span className="text-ink-2">{version.source_name}</span> and quote the passages they rely on, with page numbers. {mode.canConfirm ? "AI answers start once the workspace owner confirms their email address; until then you'll see the most relevant passages, quoted as written." : "AI answers need a confirmed email address, and this server can't send confirmation emails yet, so you'll see the most relevant passages, quoted as written."} Not legal advice.</>
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
            <nav aria-label="Example questions" className="mb-3 flex flex-wrap gap-1.5 text-xs">
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
