import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getIntake, latestDocAnalysis } from "@/lib/intake/service";
import { ANALYZE_MESSAGE, documentAi, documentConversation, documentConversations, DOC_THREAD_ID, type AnalyzeCode } from "@/lib/intake/ai-service";
import { QA_DAILY } from "@/lib/qa/store";
import type { Source } from "@/lib/intake/types";
import { verificationRequired } from "@/lib/emailverify";
import { EMAIL_HELP } from "@/lib/email-guidance";
import { askDocumentAction } from "@/app/intake-actions";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader, timeAgo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { DECISION_LABEL, DECISION_TONE, TYPE_LABEL } from "@/components/intake/labels";
import { DocumentAnalysis } from "@/components/intake/DocumentAnalysis";
import { AnalyzeButton } from "@/components/intake/AnalyzeButton";
import { CHAT_EXAMPLES, DOC_AI_COPY, DOC_AI_UNAVAILABLE } from "@/components/intake/ai-copy";
import { QaTurn } from "@/components/qa/QaTurn";
import { AskComposer } from "@/components/qa/AskComposer";

export const metadata = { title: "Document" };

const src = (s: Source) => `p. ${s.page}`;
const MAX_ROWS = 60;

function Rows({ rows }: { rows: { label: string; value: string; source?: Source }[] }) {
  if (!rows.length) return <p className="px-5 py-4 text-[13px] text-muted">None found.</p>;
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <ul className="divide-y divide-line">
      {rows.length > MAX_ROWS && <li className="px-5 py-2 text-[12px] text-muted">Showing {MAX_ROWS} of {rows.length}.</li>}
      {shown.map((r, i) => (
        <li key={i} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-muted">{r.label}</span>
            <span className="text-right text-[14px] font-medium text-ink">{r.value}</span>
          </div>
          {r.source && <blockquote className="mt-1 truncate text-[12px] text-muted" title={r.source.quote}>{src(r.source)}: “{r.source.quote}”</blockquote>}
        </li>
      ))}
    </ul>
  );
}

const CHAT_ERRORS: Record<string, string> = {
  question: "Ask a question of up to 500 characters.",
  slow: "You're asking quickly. Wait a minute and try again.",
  limit: `This workspace has reached today's question limit (${QA_DAILY.model} with the AI assistant, ${QA_DAILY.passages} without). Try again tomorrow.`,
  thread: "That conversation wasn't found, or it isn't yours to continue. Start a new one.",
  no_text: DOC_AI_UNAVAILABLE.no_text,
  failed: "Something went wrong. Try again.",
};

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ai?: string; thread?: string; q?: string; chat_error?: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const q = await searchParams;
  const g = getIntake(s, id);
  if (!g.ok) notFound();
  const { result } = g;
  const r = result.record;
  const decision = r.routing.decision;
  const name = result.filename ?? (result.source === "paste" ? "Pasted text" : "Document");
  // no model call: whether AI would run for this document now, and Claude's latest analysis of it
  const ai = documentAi(s, result.id);
  const latest = latestDocAnalysis(s.workspaceId, result.id);
  const aiError = q.ai && Object.hasOwn(ANALYZE_MESSAGE, q.ai) && !latest ? ANALYZE_MESSAGE[q.ai as AnalyzeCode] : null;
  const threadId = q.thread && DOC_THREAD_ID.test(q.thread) ? q.thread : undefined;
  const turns = threadId ? documentConversation(s, result.id, threadId) : [];
  const mine = turns.length > 0 && turns[0].askedById === s.userId;
  const others = documentConversations(s, result.id).filter((t) => t.id !== threadId);
  const canChat = ai.available || (ai.reason !== "no_text");
  const verifyHelp = !ai.available && ai.reason === "unverified" && verificationRequired();
  return (
    <>
      <div className="mb-3 text-sm text-muted"><Link href="/app/documents" className="hover:text-ink">Document Intelligence</Link> / {name}</div>
      <PageHeader
        title={name}
        sub={`${TYPE_LABEL[r.documentType.type] ?? r.documentType.type} · ${r.pageCount} page${r.pageCount === 1 ? "" : "s"} · read ${timeAgo(result.created_at)}${latest ? ` · analyzed by Claude ${timeAgo(latest.createdAt)}` : ""}`}
        actions={<><Badge tone={DECISION_TONE[decision]}>{DECISION_LABEL[decision]}</Badge><Badge tone="neutral" icon="info">{DOC_AI_COPY.disclaimer}</Badge></>}
      />

      <Card className="mb-5" aria-labelledby="ai-analysis">
        <CardHeader
          title={<span id="ai-analysis" className="flex items-center gap-2"><Icon name="spark" size={18} className="text-brand" />AI analysis</span>}
          description="Claude reads this document and explains it in plain English. Every point quotes the text it relies on; a point whose quote isn't in the document is removed."
          action={latest && ai.available ? <AnalyzeButton intakeId={result.id} again /> : undefined}
        />
        {aiError && <div className="px-5 pt-4"><Notice tone="warn">{aiError}</Notice></div>}
        {latest ? (
          <DocumentAnalysis analysis={latest.analysis} createdAt={latest.createdAt} />
        ) : ai.available ? (
          <div className="px-5 py-5">
            <p className="mb-3 text-sm text-ink-2">Get a plain-English summary, the key terms with their quotes, and what&apos;s worth checking.</p>
            <AnalyzeButton intakeId={result.id} />
          </div>
        ) : (
          <div className="px-5 py-5">
            <Notice tone={ai.reason === "off" ? "info" : "warn"}>
              {DOC_AI_UNAVAILABLE[ai.reason]} The rules&apos; reading is below.
              {verifyHelp && <span className="mt-1 block text-[13px]">{EMAIL_HELP.verify} {EMAIL_HELP.resendAbove}</span>}
            </Notice>
          </div>
        )}
      </Card>

      <Card id="chat" className="mb-5 scroll-mt-20" aria-labelledby="chat-title">
        <CardHeader
          title={<span id="chat-title">Chat with this document</span>}
          description={ai.available
            ? "Ask about this document only. Claude answers in plain English and quotes the passages it relies on; each answer is checked against the text and by a second check, and one that can't be confirmed is withheld."
            : "Ask about this document only. Answers quote the most relevant passages, as written."}
          action={turns.length > 0 ? <Link href={`/app/documents/${result.id}#chat`} className="text-sm text-brand underline underline-offset-2">New conversation</Link> : undefined}
        />
        <div className="space-y-4 px-5 py-4">
          {q.chat_error && <Notice tone="error">{Object.hasOwn(CHAT_ERRORS, q.chat_error) ? CHAT_ERRORS[q.chat_error] : CHAT_ERRORS.failed}</Notice>}
          {!canChat ? (
            <p className="text-sm text-muted">{DOC_AI_UNAVAILABLE.no_text}</p>
          ) : (
            <>
              {!ai.available && <p className="text-[13px] text-muted">{DOC_AI_UNAVAILABLE[ai.reason]} You&apos;ll see the most relevant passages instead of an AI answer.</p>}
              {turns.length > 0 ? (
                <ol aria-label="Conversation" className="space-y-5">{turns.map((h) => <QaTurn key={h.id} h={h} docWord="document" />)}</ol>
              ) : (
                <nav aria-label="Example questions" className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="mr-1 text-muted">Try:</span>
                  {CHAT_EXAMPLES.map((e) => (
                    <Link key={e} href={`?q=${encodeURIComponent(e)}#chat`} className="rounded-full border border-line bg-white px-2.5 py-1 text-ink-2 hover:border-brand/40 hover:text-ink">{e}</Link>
                  ))}
                </nav>
              )}
              {turns.length === 0 || mine ? (
                <AskComposer action={askDocumentAction} hidden={{ intakeId: result.id }} threadId={mine ? threadId : undefined} defaultQuestion={turns.length ? "" : (q.q?.slice(0, 500) ?? "")} ai={ai.available} docWord="document" placeholder="e.g. Can either party terminate early?" />
              ) : (
                <p className="text-sm text-muted">This is {turns[0].askedBy}&apos;s conversation. <Link href={`/app/documents/${result.id}#chat`} className="text-brand underline underline-offset-2">Start your own</Link> to ask a follow-up.</p>
              )}
              {others.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted uppercase">Earlier conversations ({others.length})</summary>
                  <ul aria-label="Earlier conversations" className="mt-2 space-y-1.5">
                    {others.map((t) => (
                      <li key={t.id}>
                        <Link href={`?thread=${t.id}#chat`} className="block rounded-lg border border-line bg-white px-3 py-2 hover:border-line-strong">
                          <span className="line-clamp-2 break-words text-ink">{t.firstQuestion}</span>
                          <span className="mt-0.5 block text-xs text-muted">{t.turns} {t.turns === 1 ? "question" : "questions"} · {t.askedBy} · {timeAgo(t.lastAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </Card>

      <Card className="mb-5" aria-labelledby="draft-title">
        <CardHeader title={<span id="draft-title">Prepare an agreement draft</span>} description="Start a draft in Agreement Studio from this document. Nothing is published or sent: you check every value, and the draft goes through the usual review and approval." />
        <div className="space-y-3 px-5 py-4">
        {decision === "ready_to_prepare" && <Notice tone="ok">Every required field was found, with no conflicts or warnings. Check the values below before you start a draft.</Notice>}
        {decision === "needs_review" && (
          <Notice tone="warn">
            A person needs to review this document before anything is prepared:
            <ul className="mt-1 list-disc pl-5">{r.routing.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          </Notice>
        )}
        {decision === "unsupported" && <Notice tone="info">{r.routing.reasons.join("; ")}. Nothing can be prepared from it.</Notice>}
        {result.draft_id && (
          <Notice tone="info">
            A draft was started from this document {timeAgo(result.confirmed_at)} after the values were confirmed: <Link className="underline" href={`/app/studio/${result.draft_id}`}>open the draft</Link>.
          </Notice>
        )}
        {decision !== "unsupported" && (
          <div>
            <LinkButton href={`/app/documents/${result.id}/draft`} icon="agreement" variant={decision === "ready_to_prepare" ? "primary" : "secondary"}>
              Start a draft in Agreement Studio
            </LinkButton>
            <p className="mt-1 text-[12px] text-muted">Opens the Studio form with only the values this document states filled in{latest ? ": the rules' values, plus those Claude read and quoted (marked)" : ""}. You confirm each one; nothing is generated until you press Generate.</p>
          </div>
        )}
        </div>
      </Card>


      <div className="mb-3 mt-8 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Checked by rules</h2>
        <p className="text-[13px] text-muted">The same document read by fixed rules (no AI): a second, independent reading, each value with its quote.</p>
      </div>

      {r.injection.length > 0 && (
        <Card className="mb-5 border-amber-300">
          <CardHeader title={`Quarantined text (${r.injection.length})`} description="These lines look like instructions aimed at an AI, or use disguised letters. They were not read for any value and are never sent to a model." />
          <ul className="divide-y divide-line">
            {r.injection.slice(0, MAX_ROWS).map((q, i) => (
              <li key={i} className="px-5 py-3 text-[13px]">
                <Badge tone="warn" icon="shield">Quarantined</Badge> <span className="text-muted">{src(q)}:</span> <span className="font-mono text-ink">{q.quote}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Classification" description={r.documentType.ambiguous ? "Ambiguous between candidates." : `Decided by ${r.documentType.decidedBy}.`} />
          <Rows rows={r.documentType.reasons.map((x) => ({ label: "Why", value: x.text, source: x.source }))} />
          {r.documentType.candidates.length > 1 && (
            <p className="px-5 pb-4 text-[12px] text-muted">Candidates: {r.documentType.candidates.map((c) => `${TYPE_LABEL[c.type] ?? c.type} (${c.score})`).join(", ")}</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Parties" />
          <Rows rows={r.parties.map((p) => ({ label: p.value.role ?? "Party", value: p.value.name, source: p.source }))} />
        </Card>
        <Card>
          <CardHeader title="Dates" />
          <Rows rows={r.dates.map((d) => ({ label: d.value.kind, value: d.value.iso, source: d.source }))} />
        </Card>
        <Card>
          <CardHeader title="Amounts" />
          <Rows rows={r.amounts.map((a) => ({ label: a.value.label.replace(/_/g, " "), value: `${a.value.currency} ${a.value.amount.toLocaleString("en-US")}`, source: a.source }))} />
        </Card>
        <Card>
          <CardHeader title="Governing law and signatures" />
          <Rows rows={[
            ...r.governingLaw.map((g) => ({ label: "Governing law", value: g.value, source: g.source })),
            ...r.signatureBlocks.map((b) => ({ label: b.value.style === "conformed" ? "Signed (/s/)" : "Signature block", value: b.value.label, source: b.source })),
          ]} />
        </Card>
        <Card>
          <CardHeader title="Conflicts, missing values and warnings" />
          <Rows rows={[
            ...r.conflicts.map((c) => ({ label: `Conflict: ${c.field}`, value: c.values.map((v) => v.value).join(" vs ") })),
            ...r.missing.map((m) => ({ label: "Missing", value: m })),
            ...r.warnings.map((w) => ({ label: "Warning", value: w })),
          ]} />
        </Card>
      </div>
    </>
  );
}
