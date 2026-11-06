"use client";

import { ActionForm } from "./ActionForm";
import { useActionState } from "react";
import Link from "next/link";
import { forgotAction, importCsvAction, resetAction, type FormState } from "@/app/actions";
import { Button, Field, Input, Notice } from "./ui";

export function ForgotForm() {
  const [st, act, pending] = useActionState<FormState, FormData>(forgotAction, undefined);
  return (
    <ActionForm action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      {st?.ok && <Notice tone="ok">{st.ok}</Notice>}
      <Field label="Work email"><Input name="email" type="email" required autoFocus /></Field>
      <Button className="w-full" disabled={pending}>Email me a reset link</Button>
      <p className="text-center text-sm text-muted"><Link className="font-medium text-brand" href="/login">Back to sign in</Link></p>
    </ActionForm>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(resetAction, undefined);
  return (
    <ActionForm action={act} className="space-y-4">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      <input type="hidden" name="token" value={token} />
      <Field label="New password" hint="At least 8 characters."><Input name="password" type="password" minLength={8} required autoFocus autoComplete="new-password" /></Field>
      <Button className="w-full" disabled={pending}>Save and sign in</Button>
    </ActionForm>
  );
}

export function CsvImport() {
  const [st, act, pending] = useActionState<FormState, FormData>(importCsvAction, undefined);
  return (
    <ActionForm action={act} className="space-y-3">
      {st?.error && <Notice tone="warn">{st.error}</Notice>}
      {st?.ok && <Notice tone="ok">{st.ok}</Notice>}
      <p className="text-sm text-muted">
        One row per file. Columns: <code>client_name</code>, <code>client_email</code>, and optionally <code>company</code>, <code>ref</code>, <code>title</code>. Any other column fills the agreement blank with the same name. Each row is sent straight away.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          name="csv"
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file of clients"
          required
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && f.size > 1_000_000) {
              alert("CSV files up to 1 MB (about 5,000 rows). Split it and import in parts.");
              e.target.value = "";
            }
          }}
        />
        <Button variant="secondary" disabled={pending}>{pending ? "Importing…" : "Import and send"}</Button>
      </div>
    </ActionForm>
  );
}
