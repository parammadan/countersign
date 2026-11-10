"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardHeader, Field, Notice, Select, inputCls, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { createDraftAction, suggestAction } from "@/app/studio-actions";
import type { KindSpec, StudioAi, SuggestFailure, Suggestion } from "@/lib/drafts/service";
import { AI_COPY, AI_UNAVAILABLE } from "./ai-state";

const TERM_LABEL: Record<string, string> = {
  fee: "Fee (with currency, e.g. $5,000)", paymentDays: "Payment due (days after invoice)", startDate: "Start date", endDate: "End date",
  noticeDays: "Notice period (days)", governingLaw: "Governing law (state or country)", lateFeePercent: "Late fee (% of the overdue amount)",
  lateFeePeriod: "Late fee charged per", rent: "Rent (with currency)", deposit: "Deposit (with currency)", confidentialityYears: "Confidentiality lasts (years)",
  propertyAddress: "Property address", licensedMaterial: "Licensed material (its name)", territory: "Territory (one or more, separated by ;)",
  exclusivity: "Exclusivity", ipOwner: "Who owns the work product", licensedUse: "What the licence allows", licenceTransfer: "Sublicensing or transfer",
  feePeriod: "Retainer fee is charged per", rentSchedule: "Rent schedule", premisesUse: "Use of the premises", subletting: "Subletting",
};
const SUGGEST_FAILED: Record<SuggestFailure, string> = {
  ai_off: "AI isn't configured on this server, so fill in the form below.",
  unverified: "Confirm your email address to use the AI assistant. Until then, fill in the form below.",
  spend_cap: "AI isn't available right now (daily limit); fill in the form below.",
  limit: "Too many suggestions this hour; fill in the form below.",
  invalid: "Describe the agreement in up to 4,000 characters.",
  failed: "Claude didn't answer. Try again, or fill in the form below.",
};
const label = (k: string) => TERM_LABEL[k] ?? k;
const inputType = (t: string) => (t === "date" ? "date" : t === "int" || t === "percent" ? "number" : "text");

/** A form field whose label says when its value is Claude's suggestion (until the person changes it). */
export function FormField({ label: text, suggested, children }: { label: string; suggested: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-2">
        {text}
        {suggested && <Badge tone="warn" icon="spark">Suggested by Claude: check it</Badge>}
      </span>
      {children}
    </label>
  );
}

/**
 * What Claude's suggestion puts into the form: the agreement type, party names and terms it stated, the keys to mark
 * "Suggested by Claude" (until the person changes them), and the message to show. Pure, so it can be tested.
 */
export function suggestionToForm(sg: Suggestion, kinds: KindSpec[], current: KindSpec) {
  const k = sg.kind ? kinds.find((x) => x.kind === sg.kind) : undefined;
  const roles = (k ?? current).roles;
  const names: Record<string, string> = {};
  for (const p of sg.parties) {
    const role = roles.find((x) => x.toLowerCase() === p.role.toLowerCase());
    if (role && p.name) names[role] = p.name;
  }
  const allowed = new Set<string>((k ?? current).terms.map((t) => t.key));
  const terms = Object.fromEntries(Object.entries(sg.terms).filter(([key, v]) => typeof v === "string" && v !== "" && allowed.has(key))) as Record<string, string>;
  const marked = new Set([...(k ? ["kind"] : []), ...Object.keys(names).map((x) => `role:${x}`), ...Object.keys(terms).map((x) => `term:${x}`)]);
  const n = marked.size;
  const result: { tone: "ok" | "error"; text: string } = n
    ? { tone: "ok", text: `Claude suggested ${n} ${n === 1 ? "detail" : "details"} from your description. Each is marked below: check it, and change anything that isn't right. Only values your description states are suggested.` }
    : { tone: "error", text: "Claude couldn't find agreement details in your description. Add the parties and terms, or fill in the form below." };
  return { kind: k?.kind, names, terms, marked, result };
}

export function NewAgreement({ kinds, ai }: { kinds: KindSpec[]; ai: StudioAi }) {
  const canSuggest = ai.suggest.available;
  const canReword = ai.draft.available;
  // one notice when both steps are unavailable for the same reason
  const rewordNotice = !ai.draft.available && (ai.suggest.available || ai.suggest.reason !== ai.draft.reason) ? AI_UNAVAILABLE[ai.draft.reason] : null;
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState(kinds[0]?.kind ?? "services");
  const spec = useMemo(() => kinds.find((k) => k.kind === kind)!, [kinds, kind]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState("");
  const [suggested, setSuggested] = useState<Suggestion | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [suggesting, startSuggest] = useTransition();
  /** fields whose value came from Claude and hasn't been changed by the person since ("kind", "role:<role>", "term:<key>") */
  const [fromAi, setFromAi] = useState<Set<string>>(new Set());
  const [aiResult, setAiResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const confirm = (key: string) => fromAi.has(key) && setFromAi((s) => { const n = new Set(s); n.delete(key); return n; });

  function suggest() {
    setErrors([]);
    setInfo(null);
    setAiResult(null);
    startSuggest(async () => {
      const r = await suggestAction(description);
      if (!r.ok) {
        setAiResult({ tone: "error", text: SUGGEST_FAILED[r.code] ?? SUGGEST_FAILED.failed });
        return;
      }
      const f = suggestionToForm(r.suggestion, kinds, spec);
      setSuggested(r.suggestion);
      if (f.kind) setKind(f.kind);
      setNames(f.names);
      setTerms(f.terms);
      setFromAi(f.marked);
      setAiResult(f.result);
    });
  }

  function generate() {
    setErrors([]);
    setInfo(null);
    const parties = spec.roles.map((role) => ({ role, name: (names[role] ?? "").trim() }));
    const t: Record<string, string | number> = {};
    for (const term of spec.terms) {
      const v = (terms[term.key] ?? "").trim();
      if (!v) continue;
      t[term.key] = term.type === "int" || term.type === "percent" ? Number(v) : v;
    }
    start(async () => {
      const r = await createDraftAction({ kind: spec.kind, parties, terms: t, ...(canReword && instructions.trim() && { instructions }) });
      if (!r.ok) {
        setErrors(r.issues.length ? r.issues : ["The draft couldn't be generated."]);
        return;
      }
      router.push(`/app/studio/${r.draftId}?new=${r.landing}${r.fallback ? `&why=${r.fallback}` : ""}`);
    });
  }

  return (
    <Card>
      <CardHeader title="New agreement" description="Start from a reviewed template: let Claude suggest the details from a description, or fill them in yourself. A person always reviews and approves before anything is sent." />
      <div className="space-y-5 px-5 py-4">
        {canSuggest ? (
          <section aria-labelledby="ai-create" className="rounded-xl border border-brand/25 bg-brand/[0.04] p-4">
            <h3 id="ai-create" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
              <Icon name="spark" size={18} className="text-brand" /> {AI_COPY.heading}
            </h3>
            <p className="mt-1 text-sm text-ink-2">{AI_COPY.intro}</p>
            <Field className="mt-3" label={AI_COPY.inputLabel}>
              <textarea
                className={cx(inputCls, "min-h-24")}
                value={description}
                maxLength={4000}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={AI_COPY.placeholder}
              />
            </Field>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="button" icon="spark" onClick={suggest} loading={suggesting} disabled={!description.trim() || pending}>
                {AI_COPY.button}
              </Button>
              {suggesting && <span role="status" className="text-sm text-muted">{AI_COPY.working}</span>}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">{AI_COPY.footnote}</p>
            {aiResult && <div className="mt-3"><Notice tone={aiResult.tone}>{aiResult.text}</Notice></div>}
            {suggested && suggested.unclear.length > 0 && (
              <div className="mt-3"><Notice tone="warn">Not stated in your description: {suggested.unclear.join("; ")}</Notice></div>
            )}
          </section>
        ) : (
          <Notice tone={ai.suggest.reason === "off" ? "info" : "warn"}>{AI_UNAVAILABLE[ai.suggest.reason]}</Notice>
        )}
        {info && <Notice tone="info">{info}</Notice>}

        <section aria-labelledby="details">
          <h3 id="details" className="text-[15px] font-semibold text-ink">Agreement details</h3>
          <p className="mt-1 mb-3 text-sm text-muted">
            {canSuggest ? "Fill these in yourself, or let Claude suggest them above. Every value is yours to check before you generate." : "Fill in the details for one of the reviewed templates."}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Type of agreement" suggested={fromAi.has("kind")}>
              <Select value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); confirm("kind"); }}>
                {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
              </Select>
            </FormField>
            {spec.roles.map((role) => (
              <FormField key={role} label={`${role} (legal name)`} suggested={fromAi.has(`role:${role}`)}>
                <input className={inputCls} value={names[role] ?? ""} maxLength={200} onChange={(e) => { setNames({ ...names, [role]: e.target.value }); confirm(`role:${role}`); }} />
              </FormField>
            ))}
            {spec.terms.map((t) => (
              <FormField key={t.key} label={`${label(t.key)}${t.required ? "" : " (optional)"}`} suggested={fromAi.has(`term:${t.key}`)}>
                {t.choices ? (
                  <Select value={terms[t.key] ?? ""} onChange={(e) => { setTerms({ ...terms, [t.key]: e.target.value }); confirm(`term:${t.key}`); }}>
                    <option value="">Choose…</option>
                    {Object.entries(t.choices).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
                  </Select>
                ) : (
                  <input className={inputCls} type={inputType(t.type)} value={terms[t.key] ?? ""} maxLength={200} onChange={(e) => { setTerms({ ...terms, [t.key]: e.target.value }); confirm(`term:${t.key}`); }} />
                )}
              </FormField>
            ))}
          </div>
        </section>
        {rewordNotice && <Notice tone="warn">{rewordNotice}</Notice>}
        {canReword && (
          <Field label="Wording notes (optional)" hint="Tone or style only. Claude may adjust wording within the template's rules; it can't change parties, figures or clauses.">
            <input className={inputCls} value={instructions} maxLength={1000} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. plain English" />
          </Field>
        )}
        {fromAi.size > 0 && <Notice tone="warn">{fromAi.size} {fromAi.size === 1 ? "detail is" : "details are"} still Claude&apos;s suggestion. Check {fromAi.size === 1 ? "it" : "them"} before you generate.</Notice>}
        {errors.length > 0 && (
          <Notice tone="error">
            <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Notice>
        )}
        <Button type="button" icon="agreement" onClick={generate} loading={pending} disabled={suggesting}>Generate draft</Button>
      </div>
    </Card>
  );
}
