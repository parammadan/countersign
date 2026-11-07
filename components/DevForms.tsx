"use client";

import { ActionForm } from "./ActionForm";
import { useActionState, useId } from "react";
import { apiKeyAction, webhookAction, type FormState } from "@/app/actions";
import { Button, Input, Notice } from "./ui";
import { CopyButton } from "./FileActions";

/** An always-present live region, so screen readers announce the message when it arrives.
 *  Errors are shown separately (Notice role="alert"), outside this region. */
function Result({ st }: { st: FormState }) {
  return (
    <>
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      <div role="status" aria-live="polite" className="empty:m-0">
        {st?.ok && (
          <Notice tone="ok">
            {st.ok}
            {st.secret && (
              <span className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-xs">{st.secret}</code>
                <CopyButton text={st.secret} className="py-1 text-xs" />
              </span>
            )}
            {st.secret && <span className="mt-2 block text-xs">This is the only time it is shown. Reloading or leaving the page hides it for good.</span>}
          </Notice>
        )}
      </div>
    </>
  );
}

export function NewKeyForm() {
  const [st, act, pending] = useActionState<FormState, FormData>(apiKeyAction, undefined);
  const nameId = useId();
  return (
    <ActionForm action={act} className="space-y-3">
      <Result st={st} />
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-[13px] font-medium text-ink-2">Key name</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id={nameId} name="name" placeholder="Key name, e.g. CRM sync" maxLength={60} />
          <Button name="op" value="create" disabled={pending} className="shrink-0 whitespace-nowrap">Create API key</Button>
        </div>
      </div>
    </ActionForm>
  );
}

export function RevokeKey({ id }: { id: string }) {
  const [, act, pending] = useActionState<FormState, FormData>(apiKeyAction, undefined);
  return (
    <form action={act}>
      <input type="hidden" name="id" value={id} />
      <button name="op" value="revoke" className="min-h-9 rounded-md px-2 text-xs font-medium text-bad hover:bg-bad-bg" disabled={pending}>Revoke</button>
    </form>
  );
}

export function NewWebhookForm({ events }: { events: readonly string[] }) {
  const [st, act, pending] = useActionState<FormState, FormData>(webhookAction, undefined);
  return (
    <ActionForm action={act} className="space-y-3">
      <Result st={st} />
      <Input name="url" type="url" aria-label="Webhook URL" placeholder="https://your-n8n.example.com/webhook/countersign" required />
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm"><legend className="sr-only">Events to send</legend>
        {events.map((e) => (
          <label key={e} className="flex items-center gap-1.5">
            <input type="checkbox" name="events" value={e} defaultChecked={e === "file.completed"} /> <code className="text-xs">{e}</code>
          </label>
        ))}
      </fieldset>
      <Button name="op" value="create" disabled={pending}>Add webhook</Button>
    </ActionForm>
  );
}

export function DeleteWebhook({ id }: { id: string }) {
  const [, act, pending] = useActionState<FormState, FormData>(webhookAction, undefined);
  return (
    <form action={act}>
      <input type="hidden" name="id" value={id} />
      <button name="op" value="delete" className="min-h-9 rounded-md px-2 text-xs font-medium text-bad hover:bg-bad-bg" disabled={pending}>Remove</button>
    </form>
  );
}
