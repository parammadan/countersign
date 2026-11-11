"use client";

import { ActionForm } from "./ActionForm";
import { useActionState, useState } from "react";
import { createFileAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice, Select } from "./ui";

type T = { id: string; name: string; version: number; isDefault: boolean; prefill: { key: string; label: string }[] };

/** How an agreement is named in the picker and the summary: its name, the published version it sends, and whether it is the default. */
export const agreementLabel = (t: Pick<T, "name" | "version" | "isDefault">) => `${t.name} · version ${t.version}${t.isDefault ? " (default)" : ""}`;

export function NewFileForm({ templates, initial }: { templates: T[]; initial?: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(createFileAction, undefined);
  const [tid, setTid] = useState(templates.find((x) => x.id === initial)?.id ?? templates[0].id);
  const t = templates.find((x) => x.id === tid) ?? templates[0];
  return (
    <ActionForm action={act} className="space-y-5">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      <Field label="Agreement to send" hint={templates.length > 1 ? "Choose which published agreement this client signs. Its current published version is sent." : "Your only published agreement. Upload and publish more in Agreements to choose between them."}>
        <Select name="templateId" required value={tid} onChange={(e) => setTid(e.target.value)}>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>{agreementLabel(x)}</option>
          ))}
        </Select>
      </Field>
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
      <p role="status" aria-label="Agreement being sent" className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-ink-2">
        You&apos;re sending <span className="font-medium text-ink">{t.name}</span>, version {t.version}.
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button name="intent" value="send" disabled={pending}>{pending ? "Sending…" : "Create and send for signature"}</Button>
        <Button name="intent" value="draft" variant="secondary" disabled={pending}>Save as draft</Button>
      </div>
    </ActionForm>
  );
}
