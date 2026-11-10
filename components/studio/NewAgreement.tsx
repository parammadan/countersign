"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field, Notice, Select, inputCls, cx } from "@/components/ui";
import { createDraftAction, suggestAction } from "@/app/studio-actions";
import type { KindSpec, SuggestFailure, Suggestion } from "@/lib/drafts/service";

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
  failed: "The suggestion service didn't answer. Fill in the form below.",
};
const label = (k: string) => TERM_LABEL[k] ?? k;
const inputType = (t: string) => (t === "date" ? "date" : t === "int" || t === "percent" ? "number" : "text");

export function NewAgreement({ kinds, ai }: { kinds: KindSpec[]; ai: boolean }) {
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

  function suggest() {
    setErrors([]);
    setInfo(null);
    start(async () => {
      const r = await suggestAction(description);
      if (!r.ok) {
        setErrors([SUGGEST_FAILED[r.code] ?? SUGGEST_FAILED.failed]);
        return;
      }
      const sg = r.suggestion;
      setSuggested(sg);
      const k = sg.kind ? kinds.find((x) => x.kind === sg.kind) : undefined;
      if (k) setKind(k.kind);
      const roles = (k ?? spec).roles;
      const n: Record<string, string> = {};
      for (const p of sg.parties) {
        const role = roles.find((x) => x.toLowerCase() === p.role.toLowerCase());
        if (role) n[role] = p.name;
      }
      setNames(n);
      setTerms(Object.fromEntries(Object.entries(sg.terms).filter(([, v]) => typeof v === "string")) as Record<string, string>);
      setInfo("Filled in from your description. Check every value: only values your description states were kept, and nothing is drafted until you press Generate.");
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
      const r = await createDraftAction({ kind: spec.kind, parties, terms: t, ...(instructions.trim() && { instructions }) });
      if (!r.ok) {
        setErrors(r.issues.length ? r.issues : ["The draft couldn't be generated."]);
        return;
      }
      router.push(`/app/studio/${r.draftId}?new=${r.landing}${r.fallback ? `&why=${r.fallback}` : ""}`);
    });
  }

  return (
    <Card>
      <CardHeader title="New agreement" description="Describe what you need, check the details, then generate a draft. A person always reviews and approves before anything is sent." />
      <div className="space-y-5 px-5 py-4">
        <Field label="Describe the agreement" hint={ai ? "AI reads this and fills in the form below. It never invents values." : "AI isn't configured on this server; the form below works on its own."}>
          <textarea
            className={cx(inputCls, "min-h-24")}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A consulting agreement between Northwind Advisory LLC (consultant) and Acme Corp (client), $12,000 fee, payable within 30 days, starting 2027-01-15, 30 days' notice, Delaware law, the client owns the work."
          />
        </Field>
        {ai && (
          <Button type="button" variant="secondary" icon="spark" onClick={suggest} loading={pending} disabled={!description.trim()}>
            Fill in from description
          </Button>
        )}
        {info && <Notice tone="info">{info}</Notice>}
        {suggested && suggested.unclear.length > 0 && (
          <Notice tone="warn">Not stated in your description: {suggested.unclear.join("; ")}</Notice>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type of agreement">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
            </Select>
          </Field>
          {spec.roles.map((role) => (
            <Field key={role} label={`${role} (legal name)`}>
              <input className={inputCls} value={names[role] ?? ""} maxLength={200} onChange={(e) => setNames({ ...names, [role]: e.target.value })} />
            </Field>
          ))}
          {spec.terms.map((t) => (
            <Field key={t.key} label={`${label(t.key)}${t.required ? "" : " (optional)"}`}>
              {t.choices ? (
                <Select value={terms[t.key] ?? ""} onChange={(e) => setTerms({ ...terms, [t.key]: e.target.value })}>
                  <option value="">Choose…</option>
                  {Object.entries(t.choices).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
                </Select>
              ) : (
                <input className={inputCls} type={inputType(t.type)} value={terms[t.key] ?? ""} maxLength={200} onChange={(e) => setTerms({ ...terms, [t.key]: e.target.value })} />
              )}
            </Field>
          ))}
        </div>
        {ai && (
          <Field label="Wording notes (optional)" hint="Tone or style only. They can't change parties, figures or clauses.">
            <input className={inputCls} value={instructions} maxLength={1000} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. plain English" />
          </Field>
        )}
        {errors.length > 0 && (
          <Notice tone="error">
            <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Notice>
        )}
        <Button type="button" icon="agreement" onClick={generate} loading={pending}>Generate draft</Button>
      </div>
    </Card>
  );
}
