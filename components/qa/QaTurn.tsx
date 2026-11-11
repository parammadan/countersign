// One Q&A turn as the ask pages show it (an agreement's Ask page, and chat on a read document): the question, the
// answer with its badges (components/qaPresentation), what was checked, and every source quoted in its passage.
// Display only: whether an answer is shown, withheld or trimmed is decided in lib/qa, never here.
import { Badge, Notice, timeAgo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { qaPresentation } from "@/components/qaPresentation";
import type { Citation, QaResult } from "@/lib/qa/answer";

export type QaTurnEntry = { id: string; question: string; result: QaResult; askedBy: string; createdAt: string };

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

/** One question and its answer, as the pipeline produced it: badges per outcome, the checks, and every source quoted in its passage. */
export function QaTurn({ h, docWord = "agreement" }: { h: QaTurnEntry; docWord?: string }) {
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
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{`Sources in the ${docWord}`}</h3>
            <div className="space-y-2">{groups.map((g, i) => <Source key={i} id={`${h.id}-s${i + 1}`} n={i + 1} {...g} />)}</div>
          </section>
        )}
      </article>
    </li>
  );
}

