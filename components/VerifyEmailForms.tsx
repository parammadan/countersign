"use client";

import { useActionState } from "react";
import { usePathname } from "next/navigation";
import { confirmEmailAction, resendVerificationAction, type FormState } from "@/app/actions";
import { EMAIL_HELP } from "@/lib/email-guidance";
import { Button, Notice, cx } from "./ui";
import { Icon } from "./icons";

/** What an unconfirmed workspace can do now, and what waits for the confirmed email (the rules lib/emailverify and
 * lib/ai/budget enforce). Fixed text only. */
export const VERIFY_COPY = {
  title: "Check your inbox to confirm your email",
  sentTo: "We sent a confirmation link to",
  steps: [
    "Open the email “Confirm your email address” from AgreementOS and press Confirm my email.",
    "Not there after a few minutes? Check your Spam or Junk folder and mark the email as Not spam.",
    "Still nothing? Send a new link.",
  ],
  nowTitle: "Works right away",
  now: [
    "Upload a PDF or Word agreement, check its fields and publish it",
    "Adopt your firm's countersignature",
    "Send a test to yourself or your team",
    "Read documents in Document Intelligence by rules (no AI)",
  ],
  laterTitle: "Needs a confirmed email",
  later: [
    "AI features: Fill details with AI, Document Intelligence's AI analysis, and Claude's answers in Ask and Knowledge Hub",
    "Sending agreements to clients",
    "Inviting teammates",
  ],
} as const;

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

/** The first screen after sign-up (Overview) gets the full card; every other page a compact banner. */
export function UnverifiedBanner({ email }: { email: string }) {
  const path = usePathname();
  if (path === "/app") return <UnverifiedWelcome email={email} />;
  return (
    <div role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p>
        <b>Confirm your email to send agreements to clients.</b> We sent a link to {email}. Until then you can only send to your own team, for example with Send a test to me.
      </p>
      <VerifyEmailHelp className="mt-2" tone="amber" />
    </div>
  );
}

/** Overview, unconfirmed: the inbox and Spam/Junk steps, Resend, and what works before and after confirming. */
export function UnverifiedWelcome({ email }: { email: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(resendVerificationAction, undefined);
  return (
    <section role="status" aria-labelledby="verify-title" className="mb-7 overflow-hidden rounded-[var(--radius-lg)] border border-amber-300 bg-white shadow-2">
      <div className="flex flex-col gap-4 bg-amber-50 px-5 py-5 sm:flex-row sm:items-start sm:px-6">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-amber-700 ring-1 ring-amber-300">
          <Icon name="mail" size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="verify-title" className="text-lg font-semibold tracking-tight text-amber-950">{VERIFY_COPY.title}</h2>
          <p className="mt-1 text-sm text-amber-950">
            {VERIFY_COPY.sentTo} <b className="break-all">{email}</b>. <b>Confirm your email to send agreements to clients.</b>
          </p>
          <ol className="mt-3 space-y-1.5 text-sm text-amber-950">
            {VERIFY_COPY.steps.map((t, i) => (
              <li key={t} className="flex gap-2.5">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-[11px] font-semibold ring-1 ring-amber-300">{i + 1}</span>
                <span className="min-w-0">{t}</span>
              </li>
            ))}
          </ol>
          <form action={act} className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" icon="mail" loading={pending}>{pending ? "Sending…" : EMAIL_HELP.resend}</Button>
            <div aria-live="polite" className="text-sm">
              {st?.error && <span className="text-red-700">{st.error}</span>}
              {st?.ok && <span className="text-emerald-800">{st.ok}</span>}
            </div>
          </form>
        </div>
      </div>
      <div className="grid gap-5 border-t border-amber-200 px-5 py-4 sm:grid-cols-2 sm:px-6">
        <div>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ok"><Icon name="checkCircle" size={15} />{VERIFY_COPY.nowTitle}</h3>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
            {VERIFY_COPY.now.map((t) => <li key={t} className="flex gap-2"><span aria-hidden className="text-faint">•</span>{t}</li>)}
          </ul>
        </div>
        <div>
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-warn"><Icon name="clock" size={15} />{VERIFY_COPY.laterTitle}</h3>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
            {VERIFY_COPY.later.map((t) => <li key={t} className="flex gap-2"><span aria-hidden className="text-faint">•</span>{t}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}
