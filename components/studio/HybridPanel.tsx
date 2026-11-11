"use client";

// Hybrid drafting on a draft (behind HYBRID_DRAFTING): check every requirement in the description against the draft,
// see the coverage matrix, and review AI-proposed clauses. Nothing here approves or publishes: AI-proposed clauses
// block approval until an owner or admin marks each one reviewed. Never presented as legal advice or lawyer review.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Notice, inputCls, cx } from "@/components/ui";
import { reviewAiClauseAction, runHybridAction } from "@/app/hybrid-actions";

export type PanelRequirement = { id: string; category: string; quote: string; summary: string };
export type PanelCoverage = { id: string; status: "included" | "partial" | "changed" | "not_included"; clauses: string[]; note: string };
export type PanelAiClause = { clauseId: string; number: string; heading: string; reviewed: boolean };

const STATUS: Record<PanelCoverage["status"], { label: string; tone: "ok" | "warn" | "bad" }> = {
  included: { label: "Included", tone: "ok" },
  partial: { label: "Partly included", tone: "warn" },
  changed: { label: "Changed: check it", tone: "bad" },
  not_included: { label: "Not included", tone: "bad" },
};

export function HybridPanel({ draftId, description, requirements, coverage, aiClauses, clauseNumbers, canReview }: {
  draftId: string;
  description: string;
  requirements: PanelRequirement[];
  coverage: PanelCoverage[];
  aiClauses: PanelAiClause[];
  /** clause id → its number in the draft ("4"), for the matrix */
  clauseNumbers: Record<string, string>;
  canReview: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(description);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [running, start] = useTransition();
  const unreviewed = aiClauses.filter((c) => !c.reviewed).length;
  const counts = coverage.reduce<Record<string, number>>((n, c) => ({ ...n, [c.status]: (n[c.status] ?? 0) + 1 }), {});

  return (
    <Card className="mb-4">
      <CardHeader
        title="Requirements check (beta)"
        description="Claude lists every requirement in your description, then an independent check says which clause states each one. For anything the reviewed template can't state, Claude proposes a clause, marked AI-proposed: review each one before the draft can be approved. This is a drafting aid, not legal advice or a lawyer's review."
        action={<Badge tone="brand">Beta</Badge>}
      />
      <div className="space-y-4 px-5 pb-5">
        <label className="block text-sm font-medium text-ink">
          Your description
          <textarea className={cx(inputCls, "mt-1 min-h-24 py-2 font-normal")} value={text} maxLength={4_000} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" icon="spark" loading={running} disabled={text.trim().length < 10} onClick={() => start(async () => {
            setMsg(null);
            const r = await runHybridAction(draftId, text);
            setMsg(r.ok ? { tone: "info", text: `${r.requirements} requirements found; ${r.included} included as stated; ${r.proposed} AI-proposed ${r.proposed === 1 ? "clause" : "clauses"} added for review.` } : { tone: "error", text: r.message });
            router.refresh();
          })}>Check requirements and propose missing clauses</Button>
          {running && <span role="status" className="text-sm text-muted">Claude is reading the description and the draft…</span>}
        </div>
        {msg && <Notice tone={msg.tone === "error" ? "error" : "info"}>{msg.text}</Notice>}
        {unreviewed > 0 && <Notice tone="warn">{unreviewed} AI-proposed {unreviewed === 1 ? "clause is" : "clauses are"} not reviewed yet. The draft can&apos;t be approved or published until an owner or admin reviews {unreviewed === 1 ? "it" : "each one"}.</Notice>}

        {requirements.length > 0 && (
          <section aria-labelledby="coverage-heading">
            <h3 id="coverage-heading" className="text-sm font-semibold text-ink">
              Coverage: {counts.included ?? 0} included, {counts.partial ?? 0} partly, {counts.changed ?? 0} changed, {counts.not_included ?? 0} not included
            </h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr><th className="py-1.5 pr-3 font-medium">Requirement (your words)</th><th className="py-1.5 pr-3 font-medium">Status</th><th className="py-1.5 pr-3 font-medium">Clause</th><th className="py-1.5 font-medium">Note</th></tr>
                </thead>
                <tbody>
                  {requirements.map((r) => {
                    const c = coverage.find((x) => x.id === r.id);
                    const st = STATUS[c?.status ?? "not_included"];
                    return (
                      <tr key={r.id} className="border-t border-line align-top">
                        <td className="py-2 pr-3"><span className="text-ink">“{r.quote}”</span><span className="mt-0.5 block text-xs text-muted">{r.category}</span></td>
                        <td className="py-2 pr-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td className="py-2 pr-3 whitespace-nowrap text-ink-2">{c?.clauses.map((id) => clauseNumbers[id] ?? "?").join(", ") || "—"}</td>
                        <td className="py-2 text-ink-2">{c?.note || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {aiClauses.length > 0 && (
          <section aria-labelledby="ai-clauses-heading">
            <h3 id="ai-clauses-heading" className="text-sm font-semibold text-ink">AI-proposed clauses</h3>
            <ul className="mt-2 space-y-2">
              {aiClauses.map((c) => (
                <li key={c.clauseId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                  <span className="font-medium text-ink">Clause {c.number}: {c.heading}</span>
                  {c.reviewed ? <Badge tone="ok">Reviewed</Badge> : <Badge tone="warn">AI-proposed · not reviewed</Badge>}
                  {!c.reviewed && canReview && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => start(async () => {
                      const r = await reviewAiClauseAction(draftId, c.clauseId);
                      if (!r.ok) setMsg({ tone: "error", text: r.message });
                      router.refresh();
                    })}>I reviewed this wording</Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Edit any AI-proposed clause in the draft below like any other clause. Its wording is not from a reviewed template.</p>
          </section>
        )}
      </div>
    </Card>
  );
}
