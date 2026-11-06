"use client";

import { useActionState } from "react";
import Link from "next/link";
import { acceptInviteAction, loginAction, signupAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice } from "./ui";

export function LoginForm({ next, canReset = true }: { next?: string; canReset?: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(loginAction, undefined);
  return (
    <form action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Work email">
        <Input name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Field label="Password" hint={canReset ? <Link className="text-brand" href="/forgot">Forgot your password?</Link> : undefined}>
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button className="w-full" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
      <p className="text-center text-sm text-muted">
        New here? <Link className="font-medium text-brand" href="/signup">Create a workspace</Link>
      </p>
    </form>
  );
}

export function SignupForm() {
  const [st, act, pending] = useActionState<FormState, FormData>(signupAction, undefined);
  return (
    <form action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
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
      <Button className="w-full" disabled={pending}>{pending ? "Creating…" : "Create workspace"}</Button>
      <p className="text-center text-sm text-muted">
        Already have one? <Link className="font-medium text-brand" href="/login">Sign in</Link>
      </p>
    </form>
  );
}

export function InviteForm({ token, email, exists }: { token: string; email: string; exists: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(acceptInviteAction, undefined);
  return (
    <form action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
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
        <Input name="password" type="password" required minLength={exists ? 1 : 8} />
      </Field>
      <Button className="w-full" disabled={pending}>{pending ? "Joining…" : "Join workspace"}</Button>
    </form>
  );
}
