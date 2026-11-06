"use client";

import { ActionForm } from "./ActionForm";
import { useActionState, useState } from "react";
import { createFileAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice, Select } from "./ui";

type T = { id: string; name: string; prefill: { key: string; label: string }[] };

export function NewFileForm({ templates }: { templates: T[] }) {
  const [st, act, pending] = useActionState<FormState, FormData>(createFileAction, undefined);
  const [tid, setTid] = useState(templates[0].id);
  const t = templates.find((x) => x.id === tid) ?? templates[0];
  return (
    <ActionForm action={act} className="space-y-5">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      {templates.length > 1 && (
        <Field label="Agreement">
          <Select name="templateId" value={tid} onChange={(e) => setTid(e.target.value)}>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </Select>
        </Field>
      )}
      {templates.length === 1 && <input type="hidden" name="templateId" value={tid} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client full name">
          <Input name="clientName" required placeholder="Jordan Sample" autoComplete="off" />
        </Field>
        <Field label="Client email" hint="The signing link goes here.">
          <Input name="clientEmail" type="email" required placeholder="jordan@example.com" autoComplete="off" />
        </Field>
        <Field label="Client company" hint="Optional">
          <Input name="clientCompany" placeholder="Sample Holdings LLC" />
        </Field>
        <Field label="File / matter reference" hint="Optional. Your CRM or case number.">
          <Input name="ref" placeholder="2026-0142" />
        </Field>
      </div>
      <Field label="File title" hint={`Optional. Defaults to "${t.name}: <client name>".`}>
        <Input name="title" placeholder="Website rebuild for Sample Holdings" />
      </Field>
      {t.prefill.length > 0 && (
        <div className="rounded-lg border border-line bg-gray-50 p-4">
          <div className="mb-3 text-sm font-medium">Blanks in this agreement</div>
          <div className="grid gap-4 sm:grid-cols-2">
            {t.prefill.map((p) => (
              <Field key={p.key} label={p.label}>
                <Input name={`prefill.${p.key.slice(7)}`} />
              </Field>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button name="intent" value="send" disabled={pending}>{pending ? "Sending…" : "Create and send for signature"}</Button>
        <Button name="intent" value="draft" variant="secondary" disabled={pending}>Save as draft</Button>
      </div>
    </ActionForm>
  );
}
