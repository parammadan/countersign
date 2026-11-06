"use client";

import { ActionForm } from "./ActionForm";
import { useActionState } from "react";
import { apiKeyAction, webhookAction, type FormState } from "@/app/actions";
import { Button, Input, Notice } from "./ui";
import { CopyButton } from "./FileActions";

function Secret({ st }: { st: FormState }) {
  if (!st) return null;
  if (st.error) return <Notice tone="error">{st.error}</Notice>;
  return (
    <Notice tone="ok">
      {st.ok}
      {st.secret && (
        <span className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs">{st.secret}</code>
          <CopyButton text={st.secret} className="py-1 text-xs" />
        </span>
      )}
    </Notice>
  );
}

export function NewKeyForm() {
  const [st, act, pending] = useActionState<FormState, FormData>(apiKeyAction, undefined);
  return (
    <ActionForm action={act} className="space-y-3">
      <Secret st={st} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input name="name" placeholder="Key name, e.g. CRM sync" maxLength={60} />
        <Button name="op" value="create" disabled={pending} className="shrink-0 whitespace-nowrap">Create API key</Button>
      </div>
    </ActionForm>
  );
}

export function RevokeKey({ id }: { id: string }) {
  const [, act, pending] = useActionState<FormState, FormData>(apiKeyAction, undefined);
  return (
    <form action={act}>
      <input type="hidden" name="id" value={id} />
      <button name="op" value="revoke" className="text-xs font-medium text-bad" disabled={pending}>Revoke</button>
    </form>
  );
}

export function NewWebhookForm({ events }: { events: readonly string[] }) {
  const [st, act, pending] = useActionState<FormState, FormData>(webhookAction, undefined);
  return (
    <ActionForm action={act} className="space-y-3">
      <Secret st={st} />
      <Input name="url" type="url" placeholder="https://your-n8n.example.com/webhook/countersign" required />
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
        {events.map((e) => (
          <label key={e} className="flex items-center gap-1.5">
            <input type="checkbox" name="events" value={e} defaultChecked={e === "file.completed"} /> <code className="text-xs">{e}</code>
          </label>
        ))}
      </div>
      <Button name="op" value="create" disabled={pending}>Add webhook</Button>
    </ActionForm>
  );
}

export function DeleteWebhook({ id }: { id: string }) {
  const [, act, pending] = useActionState<FormState, FormData>(webhookAction, undefined);
  return (
    <form action={act}>
      <input type="hidden" name="id" value={id} />
      <button name="op" value="delete" className="text-xs font-medium text-bad" disabled={pending}>Remove</button>
    </form>
  );
}
