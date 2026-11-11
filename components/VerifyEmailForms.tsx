"use client";

import { useActionState } from "react";
import { confirmEmailAction, resendVerificationAction, type FormState } from "@/app/actions";
import { EMAIL_HELP } from "@/lib/email-guidance";
import { Button, Notice, cx } from "./ui";

export function ConfirmEmailForm({ token }: { token: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(confirmEmailAction, undefined);
  return (
    <div className="space-y-4">
      <form action={act} className="space-y-4">
        {st?.error && <Notice tone="error">{st.error}</Notice>}
        <input type="hidden" name="token" value={token} />
        <p className="text-sm text-muted">One click confirms this address, and your workspace can then send agreements to clients.</p>
        <Button className="w-full" disabled={pending}>{pending ? "Confirming…" : "Confirm my email"}</Button>
      </form>
      {/* an invalid or expired link: send a fresh one (signs in first if needed) */}
      {st?.error && <VerifyEmailHelp />}
    </div>
  );
}

/** The confirm-your-email guidance and the Resend link action, shared by every screen that asks for confirmation. */
export function VerifyEmailHelp({ className, tone = "plain" }: { className?: string; tone?: "plain" | "amber" }) {
  const [st, act, pending] = useActionState<FormState, FormData>(resendVerificationAction, undefined);
  return (
    <div className={cx("text-sm", className)}>
      <form action={act} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>{EMAIL_HELP.verify}</span>
        <button
          disabled={pending}
          className={cx(
            "shrink-0 rounded-md border bg-white px-3 py-1.5 font-medium disabled:opacity-60",
            tone === "amber" ? "border-amber-400 hover:bg-amber-100" : "border-line hover:bg-subtle",
          )}
        >
          {pending ? "Sending…" : EMAIL_HELP.resend}
        </button>
      </form>
      <div aria-live="polite">
        {st?.error && <p className="mt-2 text-red-700">{st.error}</p>}
        {st?.ok && <p className="mt-2 text-emerald-800">{st.ok}</p>}
      </div>
    </div>
  );
}

export function UnverifiedBanner({ email }: { email: string }) {
  return (
    <div role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p>
        <b>Confirm your email to send agreements to clients.</b> We sent a link to {email}. Until then you can only send to your own team, for example with Send a test to me.
      </p>
      <VerifyEmailHelp className="mt-2" tone="amber" />
    </div>
  );
}
