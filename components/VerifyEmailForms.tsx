"use client";

import { useActionState } from "react";
import { confirmEmailAction, resendVerificationAction, type FormState } from "@/app/actions";
import { Button, Notice } from "./ui";

export function ConfirmEmailForm({ token }: { token: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(confirmEmailAction, undefined);
  return (
    <form action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-muted">One click confirms this address, and your workspace can then send agreements to clients.</p>
      <Button className="w-full" disabled={pending}>{pending ? "Confirming…" : "Confirm my email"}</Button>
    </form>
  );
}

export function UnverifiedBanner({ email }: { email: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(resendVerificationAction, undefined);
  return (
    <div role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <form action={act} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>
          <b>Confirm your email to send agreements to clients.</b> We sent a link to {email}. Until then you can only send to your own team, for example with Send a test to me.
        </span>
        <button disabled={pending} className="shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1.5 font-medium hover:bg-amber-100 disabled:opacity-60">
          {pending ? "Sending…" : "Resend link"}
        </button>
      </form>
      {st?.error && <p className="mt-2 text-red-700">{st.error}</p>}
      {st?.ok && <p className="mt-2 text-emerald-800">{st.ok}</p>}
    </div>
  );
}
