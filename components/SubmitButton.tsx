"use client";

// A form's submit button that knows its form is being submitted: disabled with a spinner while a server action
// runs, so a slow action can't be clicked twice and the person can see something is happening.
import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "./ui";

export function SubmitButton({ pendingLabel, children, ...p }: Omit<ComponentProps<typeof Button>, "type" | "loading"> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button {...p} type="submit" loading={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
