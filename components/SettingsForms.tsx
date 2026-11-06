"use client";

import { ActionForm } from "./ActionForm";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { inviteAction, memberAction, settingsAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice } from "./ui";
import { SignaturePad, type Adopted } from "./SignaturePad";
import { CopyButton } from "./FileActions";
import type { Workspace } from "@/lib/types";

export function SettingsForm({ ws, emailOn = true }: { ws: Workspace; emailOn?: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(settingsAction, undefined);
  return (
    <ActionForm action={act} className="space-y-6">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      {st?.ok && <Notice tone="ok">{st.ok}</Notice>}
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Firm name (shown to clients)"><Input name="name" defaultValue={ws.name} required /></Field>
        <Field label="Legal entity name" hint="Used to recognise your signature block in agreements."><Input name="legal_name" defaultValue={ws.legal_name} required /></Field>
        <Field label="Email sender name"><Input name="sender_name" defaultValue={ws.sender_name} required /></Field>
        <Field label="Reply-to email" hint="Where client replies go."><Input name="reply_to" type="email" defaultValue={ws.reply_to ?? ""} /></Field>
        <Field label="Brand color" hint="Used on the signing page and in emails."><input name="brand_color" type="color" defaultValue={ws.brand_color} className="block h-10 w-20 cursor-pointer rounded-lg border border-line-strong bg-white p-1 shadow-1" /></Field>
      </section>
      <section>
        <h3 className="mb-3 font-semibold">Countersigner</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name"><Input name="countersigner_name" defaultValue={ws.countersigner_name ?? ""} /></Field>
          <Field label="Title"><Input name="countersigner_title" defaultValue={ws.countersigner_title ?? ""} placeholder="Managing Partner" /></Field>
          <Field label="Email" hint="Gets the signed copies."><Input name="countersigner_email" type="email" defaultValue={ws.countersigner_email ?? ""} /></Field>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">Automation</h3>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="auto_countersign" defaultChecked={!!ws.auto_countersign} className="mt-0.5 h-4 w-4" />
          <span><b>Countersign automatically</b> when the client signs, using the adopted signature. Turn this off to review each one first.</span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="require_otp" defaultChecked={!!ws.require_otp} className="mt-0.5 h-4 w-4" />
          <span><b>Require an emailed code</b> before the client can open the agreement (stronger proof of identity, one extra step).{!emailOn && <span className="text-warn"> Needs email delivery, which isn&apos;t configured on this server.</span>}</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reminder days" hint="Days after sending. 2,5 = reminders on day 2 and day 5."><Input name="reminder_days" defaultValue={ws.reminder_days} /></Field>
          <Field label="Link expires after (days)"><Input name="expiry_days" type="number" min={1} max={90} defaultValue={ws.expiry_days} /></Field>
        </div>
      </section>
      <Button disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
    </ActionForm>
  );
}

export function CountersignForm({ ws, current }: { ws: Workspace; current: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!current);
  const [name, setName] = useState(ws.countersigner_name ?? "");
  const [title, setTitle] = useState(ws.countersigner_title ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  async function adopt(a: Adopted) {
    setErr(null);
    const r = await fetch("/api/settings/signature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature: a.png, name, title }) });
    if (!r.ok) return setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save");
    setOk(true);
    setEditing(false);
    router.refresh();
  }
  return (
    <div className="space-y-4">
      {ok && <Notice tone="ok">Countersignature adopted. It will be applied to each completed agreement.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {current && !editing ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="rounded-lg border border-line bg-gray-50 px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current} alt="Adopted countersignature" className="h-12 object-contain" />
            <div className="mt-1 text-xs text-muted">{ws.countersigner_name}{ws.countersigner_title ? `, ${ws.countersigner_title}` : ""}</div>
          </div>
          <Button variant="secondary" onClick={() => setEditing(true)}>Change</Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Signing as"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></Field>
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Managing Partner" /></Field>
          </div>
          <SignaturePad mode="signature" defaultName={name} onAdopt={adopt} onCancel={() => setEditing(false)} />
          <p className="text-xs text-muted">By adopting this signature you authorize it to be applied on behalf of {ws.legal_name} to each agreement a client signs, and each use is recorded in that file&apos;s audit trail.</p>
        </>
      )}
    </div>
  );
}

export function InviteForm() {
  const [st, act, pending] = useActionState<FormState, FormData>(inviteAction, undefined);
  return (
    <ActionForm action={act} className="space-y-3">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      {st?.ok && (
        <Notice tone="ok">
          {st.ok} {st.secret && <span className="mt-2 flex items-center gap-2"><code className="truncate text-xs">{st.secret}</code><CopyButton text={st.secret} label="Copy link" className="py-1 text-xs" /></span>}
        </Notice>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input name="email" type="email" placeholder="colleague@example.com" required />
        <select name="role" aria-label="Role for the new teammate" className="rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <option value="staff">Staff: opens files</option>
          <option value="admin">Admin: also edits agreements & settings</option>
        </select>
        <Button disabled={pending}>Invite</Button>
      </div>
    </ActionForm>
  );
}

export function MemberRow({ m, self }: { m: { user_id: string; name: string; email: string; role: string }; self: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(memberAction, undefined);
  return (
    <li className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0 truncate">
        {m.name} <span className="text-muted">· {m.email}</span>
        {st?.error && <span className="ml-2 text-xs text-bad">{st.error}</span>}
      </span>
      {self || m.role === "owner" ? (
        <span className="text-xs capitalize text-muted">{m.role}{self ? " (you)" : ""}</span>
      ) : (
        <form action={act} className="flex items-center gap-2">
          <input type="hidden" name="userId" value={m.user_id} />
          <select name="role" aria-label={`Role for ${m.name}`} defaultValue={m.role} className="rounded-md border border-line bg-white px-2 py-1 text-xs" onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
          <input type="hidden" name="op" value="role" />
          <button
            type="submit"
            formAction={(fd: FormData) => {
              fd.set("op", "remove");
              return act(fd);
            }}
            disabled={pending}
            className="text-xs font-medium text-bad"
            onClick={(e) => !confirm(`Remove ${m.email} from the workspace?`) && e.preventDefault()}
          >
            Remove
          </button>
        </form>
      )}
    </li>
  );
}

export function InviteRow({ i }: { i: { id: string; email: string; role: string; expired: boolean } }) {
  const [, act, pending] = useActionState<FormState, FormData>(memberAction, undefined);
  return (
    <li className="flex items-center justify-between px-4 py-2.5 text-muted">
      <span className="truncate">{i.email}</span>
      <form action={act} className="flex items-center gap-3 text-xs">
        <span>{i.expired ? "invite expired" : "invited"} · {i.role}</span>
        <input type="hidden" name="id" value={i.id} />
        <button name="op" value="revoke" disabled={pending} className="font-medium text-bad">Revoke</button>
      </form>
    </li>
  );
}
