"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field, Notice, Select, inputCls } from "@/components/ui";
import { startDraftAction } from "@/app/intake-actions";
import type { Clarifications, KindSpec } from "@/lib/drafts/service";
import { ClarificationGroups, visibleClarifications } from "@/components/studio/NewAgreement";
import { TERM_LABEL } from "./labels";

/** Studio's groups, worded for a document: what's still needed, what's optional, and what the template can't include. */
export const DOC_GROUP_TITLES = {
  needed: "Needed before you can generate",
  optional: "Optional — not in the document",
  unsupported: "In the document, but this template can't include it",
} as const;

const inputType = (t: string) => (t === "date" ? "date" : t === "int" || t === "percent" ? "number" : "text");

/**
 * The Agreement Studio form, opened from a read document: only values the document states are filled in (and
 * marked), everything else is empty. Values only Claude's analysis read are marked as such (each was checked against
 * its quote on the server). What the template can't include is listed under Studio's own groups, never dropped.
 * Nothing is generated until the user checks the values and presses Generate.
 */
export function DraftFromIntake({ intakeId, kinds, initial }: {
  intakeId: string;
  kinds: KindSpec[];
  initial: { kind: string | null; names: Record<string, string>; terms: Record<string, string>; notes: string[]; ai?: { names: Record<string, string>; terms: Record<string, string> }; clarifications?: Clarifications };
}) {
  const router = useRouter();
  const [kind, setKind] = useState(initial.kind ?? kinds[0]?.kind ?? "services");
  const spec = useMemo(() => kinds.find((k) => k.kind === kind)!, [kinds, kind]);
  const [names, setNames] = useState<Record<string, string>>(initial.kind ? initial.names : {});
  const [terms, setTerms] = useState<Record<string, string>>(initial.kind ? initial.terms : {});
  const [confirmed, setConfirmed] = useState(false);
  const [kindChosen, setKindChosen] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, start] = useTransition();
  // marked while the value is still the one read from the document, whichever agreement type is chosen
  const fromDoc = (field: string, value: string | undefined) => !!value && value === (field.startsWith("role:") ? initial.names[field.slice(5)] : initial.terms[field]);
  // read by Claude only (not by the rules), still unchanged
  const byAi = (field: string, value: string | undefined) => fromDoc(field, value) && !!(field.startsWith("role:") ? initial.ai?.names[field.slice(5)] : initial.ai?.terms[field]);
  const groups = initial.clarifications ? visibleClarifications(initial.clarifications, spec, names, terms, kindChosen) : null;

  function generate() {
    setErrors([]);
    const parties = spec.roles.map((role) => ({ role, name: (names[role] ?? "").trim() }));
    const t: Record<string, string | number> = {};
    for (const term of spec.terms) {
      const v = (terms[term.key] ?? "").trim();
      if (!v) continue;
      t[term.key] = term.type === "int" || term.type === "percent" ? Number(v) : v;
    }
    start(async () => {
      const r = await startDraftAction(intakeId, { kind: spec.kind, parties, terms: t }, confirmed);
      if (!r.ok) return setErrors("issues" in r && r.issues.length ? r.issues : ["message" in r ? r.message : "The draft couldn't be generated."]);
      router.push(`/app/studio/${r.draftId}?new=${r.landing}${r.fallback ? `&why=${r.fallback}` : ""}`);
    });
  }

  const mark = (on: boolean, ai = false) => (on ? (ai ? " (from the document, read by AI: check it)" : " (from the document)") : "");
  return (
    <Card>
      <CardHeader title="Start a draft in Agreement Studio" description={initial.ai ? "Values marked “from the document” were read from it, by the rules or by Claude (each Claude value is in its quote in the document); everything else is up to you. Check each one before you generate." : "Values marked “from the document” were read from it; everything else is up to you. Check each one before you generate."} />
      <div className="space-y-5 px-5 py-4">
        {initial.notes.length > 0 && <Notice tone="warn"><ul className="list-disc pl-5">{initial.notes.map((n) => <li key={n}>{n}</li>)}</ul></Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type of agreement">
            <Select value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setKindChosen(true); }}>
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}
            </Select>
          </Field>
          {spec.roles.map((role) => (
            <Field key={role} label={`${role} (legal name)${mark(fromDoc(`role:${role}`, names[role]), byAi(`role:${role}`, names[role]))}`}>
              <input className={inputCls} value={names[role] ?? ""} maxLength={200} onChange={(e) => setNames({ ...names, [role]: e.target.value })} />
            </Field>
          ))}
          {spec.terms.map((t) => (
            <Field key={t.key} label={`${TERM_LABEL[t.key] ?? t.key}${t.required ? "" : " (optional)"}${mark(fromDoc(t.key, terms[t.key]), byAi(t.key, terms[t.key]))}`}>
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
        {groups && <ClarificationGroups groups={groups} titles={DOC_GROUP_TITLES} />}
        <label className="flex items-start gap-2 text-[14px] text-ink">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
          I checked these values against the document.
        </label>
        {errors.length > 0 && <Notice tone="error"><ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice>}
        <Button type="button" icon="agreement" onClick={generate} loading={pending} disabled={!confirmed}>Generate draft</Button>
      </div>
    </Card>
  );
}
