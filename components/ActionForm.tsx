"use client";

import { startTransition, type ComponentProps } from "react";

// A <form> for useActionState that keeps what the person typed. With <form action={fn}>, React 19 resets
// every field after the action runs, so an error ("wrong password", "reference already used") wipes the form.
export function ActionForm({ action, ...p }: Omit<ComponentProps<"form">, "action" | "onSubmit"> & { action: (fd: FormData) => void }) {
  return (
    <form
      {...p}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => action(fd));
      }}
    />
  );
}
