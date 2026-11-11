// Claude's analysis of one read document, as stored after the checks in lib/intake/ai.ts: the plain-English summary,
// the key terms by topic (each with the quote that supports it), what's worth checking (missing / unclear /
// conflicting), and where Claude's reading and the rules' reading disagree. Display only: what is shown, dropped or
// marked unconfirmed was decided on the server.
import { Badge, timeAgo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { CHECK_KINDS, TOPICS, TOPIC_LABEL, type Cite, type CheckKind, type DocAnalysis, type DocFinding } from "@/lib/intake/ai";
import { DOC_AI_COPY } from "./ai-copy";

const STATUS = {
  confirmed: { label: "Quoted", tone: "ok", icon: "checkCircle" },
  unconfirmed: { label: "Not confirmed", tone: "warn", icon: "alert" },
  unclear: { label: "Unclear", tone: "warn", icon: "alert" },
} as const satisfies Record<DocFinding["status"], { label: string; tone: "ok" | "warn"; icon: "checkCircle" | "alert" }>;
const CHECK: Record<CheckKind, { title: string; badge: string; intro: string }> = {
  missing: { title: "Not found in the document", badge: "Missing", intro: "Points a document like this often covers that Claude didn't find. Nothing was filled in for them." },
  ambiguous: { title: "Unclear wording", badge: "Unclear", intro: "Passages that may be read more than one way." },
  conflicting: { title: "Passages that may conflict", badge: "Conflicting", intro: "Places where the document may say different things about the same point." },
};

export function Quotes({ cites, label = "Where the document says it" }: { cites: Cite[]; label?: string }) {
  if (!cites.length) return null;
  return (
    <ul aria-label={label} className="mt-1.5 space-y-1">
      {cites.map((c, i) => (
        <li key={i} className="border-l-2 border-brand/40 pl-2.5 text-[12px] leading-relaxed text-muted">
          <span className="font-medium text-ink-2">p. {c.page}</span> “<span className="break-words">{c.quote}</span>”
        </li>
      ))}
    </ul>
  );
}

function Finding({ f }: { f: DocFinding }) {
  const st = STATUS[f.status];
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-muted">{f.label}</span>
        <span className="flex items-center gap-2">
          {f.value && <span className="text-right text-[14px] font-medium break-words text-ink">{f.value}</span>}
          <Badge tone={st.tone} icon={st.icon}>{st.label}</Badge>
        </span>
      </div>
      {f.explanation && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{f.explanation}</p>}
      {f.note && <p className="mt-1 text-[12px] text-warn">{f.note}</p>}
      <Quotes cites={f.evidence} />
    </li>
  );
}

export function DocumentAnalysis({ analysis: a, createdAt }: { analysis: DocAnalysis; createdAt: string }) {
  const topics = TOPICS.filter((t) => a.findings.some((f) => f.topic === t));
  return (
    <div className="divide-y divide-line">
      <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-xs text-muted">
        <Badge tone="brand" icon="spark">Claude ({a.model})</Badge>
        <span>Analyzed {timeAgo(createdAt)} · every point checked against the document&apos;s text</span>
        <Badge tone="neutral" icon="info">{DOC_AI_COPY.disclaimer}</Badge>
      </div>

      <section aria-labelledby="ai-summary" className="px-5 py-4">
        <h3 id="ai-summary" className="text-xs font-semibold tracking-wide text-muted uppercase">In plain English</h3>
        {a.summary.length ? (
          <ul className="mt-2 space-y-2">
            {a.summary.map((s, i) => (
              <li key={i} className="text-[15px] leading-relaxed text-ink">
                {s.text}
                {s.evidence.length > 0 && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-xs text-brand">Source: page {[...new Set(s.evidence.map((e) => e.page))].join(", ")}</summary>
                    <Quotes cites={s.evidence} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No summary passed the checks against the document. The key terms below are each quoted.</p>
        )}
      </section>

      {(a.warnings.length > 0 || a.disagreements.length > 0) && (
        <section aria-label="Checks" className="space-y-2 px-5 py-4">
          {a.disagreements.length > 0 && (
            <div role="note" aria-label="Claude and the rules disagree" className="rounded-lg border border-amber-200 bg-warn-bg px-3.5 py-3 text-sm text-amber-950">
              <p className="font-medium">Claude and the rules read these differently. Check them against the document:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {a.disagreements.map((d) => (
                  <li key={d.field}>
                    <span className="font-medium">{d.label}</span>: Claude read {d.ai.length ? d.ai.map((x) => `“${x}”`).join(", ") : "nothing (it reported this as not found)"}; the rules read {d.rules.map((x) => `“${x.quote}” (p. ${x.page})`).join(", ")}.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.warnings.length > 0 && (
            <ul aria-label="Notes on the analysis" className="space-y-1 text-xs text-warn">
              {a.warnings.map((w, i) => <li key={i} className="flex gap-1.5"><Icon name="alert" size={14} className="mt-[1px] shrink-0" aria-hidden />{w}</li>)}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="ai-terms" className="px-5 py-4">
        <h3 id="ai-terms" className="text-xs font-semibold tracking-wide text-muted uppercase">Key terms</h3>
        {topics.length ? (
          <div className="mt-1 grid gap-x-8 md:grid-cols-2">
            {topics.map((t) => (
              <div key={t} className="min-w-0">
                <h4 className="mt-3 text-[13px] font-semibold text-ink">{TOPIC_LABEL[t]}</h4>
                <ul className="divide-y divide-line">{a.findings.filter((f) => f.topic === t).map((f) => <Finding key={f.id} f={f} />)}</ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No term passed the checks against the document.</p>
        )}
      </section>

      <section aria-labelledby="ai-check" className="px-5 py-4">
        <h3 id="ai-check" className="text-xs font-semibold tracking-wide text-muted uppercase">Worth checking</h3>
        {a.worthChecking.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Claude didn&apos;t flag anything. That doesn&apos;t mean nothing is missing: read the document before relying on it.</p>
        ) : (
          <div className="mt-2 space-y-4">
            {CHECK_KINDS.filter((k) => a.worthChecking.some((w) => w.kind === k)).map((k) => (
              <div key={k} aria-label={CHECK[k].title} role="group">
                <p className="text-[13px] font-semibold text-ink">{CHECK[k].title}</p>
                <p className="text-xs text-muted">{CHECK[k].intro}</p>
                <ul className="mt-1 divide-y divide-line">
                  {a.worthChecking.filter((w) => w.kind === k).map((w, i) => (
                    <li key={i} className="py-2.5">
                      <div className="flex items-center gap-2">
                        <Badge tone={k === "missing" ? "neutral" : "warn"}>{CHECK[k].badge}</Badge>
                        <span className="text-[14px] font-medium text-ink">{w.label}</span>
                      </div>
                      {w.text && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{w.text}</p>}
                      {w.note && <p className="mt-1 text-[12px] text-warn">{w.note}</p>}
                      <Quotes cites={w.evidence} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
