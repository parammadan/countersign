"use client";

import { ActionForm } from "./ActionForm";
import { useActionState } from "react";
import Link from "next/link";
import { acceptInviteAction, loginAction, signupAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice } from "./ui";

export const AUTH_COPY = {
  forgot: "Forgot your password?",
  loginHelp: "Check the email address and password, or",
  reset: "reset your password",
  newHere: "New here?",
  create: "Create a workspace",
  signupConfirm: "Next, we email you a link to confirm your address (check Spam or Junk if it isn't in your inbox). Uploading and signing work right away; AI features and sending to clients start once you confirm.",
} as const;

export function LoginForm({ next }: { next?: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(loginAction, undefined);
  return (
    <ActionForm action={act} className="space-y-4">
      {st?.error && (
        <Notice tone="error">
          <span id="form-error" className="font-medium">{st.error}</span>
          <span className="mt-1 block">
            {AUTH_COPY.loginHelp} <Link className="font-medium underline" href="/forgot">{AUTH_COPY.reset}</Link>.
          </span>
        </Notice>
      )}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Work email">
        <Input name="email" type="email" autoComplete="email" required autoFocus aria-invalid={st?.error ? true : undefined} aria-describedby={st?.error ? "form-error" : undefined} />
      </Field>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label htmlFor="login-password" className="text-[13px] font-medium text-ink-2">Password</label>
          <Link className="text-[13px] font-medium text-brand hover:underline" href="/forgot">{AUTH_COPY.forgot}</Link>
        </div>
        <Input id="login-password" name="password" type="password" autoComplete="current-password" required aria-invalid={st?.error ? true : undefined} aria-describedby={st?.error ? "form-error" : undefined} />
      </div>
      <Button className="w-full" loading={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
      <p className="text-center text-sm text-muted">
        {AUTH_COPY.newHere} <Link className="font-medium text-brand" href="/signup">{AUTH_COPY.create}</Link>
      </p>
    </ActionForm>
  );
}

export function SignupForm({ confirmNote = false }: { confirmNote?: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(signupAction, undefined);
  return (
    <ActionForm action={act} className="space-y-4">
      {st?.error && <Notice tone="error"><span id="form-error">{st.error}</span></Notice>}
      <Field label="Firm name" hint="Shown to clients on emails and the signing page.">
        <Input name="firm" required placeholder="Northwind Advisory" autoFocus />
      </Field>
      <Field label="Legal entity name" hint="As it appears in your agreement. We use it to tell your signature block from the client's.">
        <Input name="legal" placeholder="Northwind Advisory, LLC" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name">
          <Input name="name" required autoComplete="name" />
        </Field>
        <Field label="Work email">
          <Input name="email" type="email" required autoComplete="email" />
        </Field>
      </div>
      <Field label="Password" hint="At least 8 characters.">
        <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </Field>
      {confirmNote && <p className="rounded-lg border border-line bg-subtle px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">{AUTH_COPY.signupConfirm}</p>}
      <Button className="w-full" loading={pending}>{pending ? "Creating…" : "Create workspace"}</Button>
      <p className="text-center text-sm text-muted">
        Already have one? <Link className="font-medium text-brand" href="/login">Sign in</Link>
      </p>
    </ActionForm>
  );
}

export function InviteForm({ token, email, exists }: { token: string; email: string; exists: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(acceptInviteAction, undefined);
  return (
    <ActionForm action={act} className="space-y-4">
      {st?.error && <Notice tone="error"><span id="form-error">{st.error}</span></Notice>}
      <input type="hidden" name="token" value={token} />
      <Field label="Email">
        <Input value={email} disabled readOnly />
      </Field>
      {!exists && (
        <Field label="Your name">
          <Input name="name" required />
        </Field>
      )}
      <Field label={exists ? "Your existing password" : "Choose a password"}>
        <Input name="password" type="password" required minLength={exists ? 1 : 8} aria-invalid={st?.error ? true : undefined} aria-describedby={st?.error ? "form-error" : undefined} />
      </Field>
      <Button className="w-full" loading={pending}>{pending ? "Joining…" : "Join workspace"}</Button>
    </ActionForm>
  );
}
