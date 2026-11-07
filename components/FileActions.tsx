"use client";

import { useActionState, useState } from "react";
import { fileAction, type FormState } from "@/app/actions";
import { Button, Notice, inputCls } from "./ui";
import type { FileStatus } from "@/lib/types";

export function CopyButton({ text, label = "Copy", className, done: doneLabel = "Copied ✓", size }: { text: string; label?: string; className?: string; done?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size={size}
        icon={done ? "check" : "copy"}
        className={className}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          setDone(true);
          setTimeout(() => setDone(false), 2500);
        }}
      >
        {done ? doneLabel : label}
      </Button>
      <span className="sr-only" aria-live="polite">{done ? `${label}: copied to the clipboard` : ""}</span>
    </>
  );
}

type Props = {
  fileId: string;
  status: FileStatus;
  link: string | null;
  admin: boolean;
  inviteFailed: boolean;
  canResendCopy: boolean;
  copyFailed: boolean;
  countersigner: string;
};

/**
 * The workflow actions for the file's current state, and nothing else: one primary action, a few secondary
 * ones. Every button runs a real server action (app/actions.ts fileAction), which re-checks state and role.
 */
export function FileActions({ fileId, status, link, admin, inviteFailed, canResendCopy, copyFailed, countersigner }: Props) {
  const [st, act, pending] = useActionState<FormState, FormData>(fileAction, undefined);
  const [op, setOp] = useState<string | null>(null);
  const open = status === "sent" || status === "viewed";
  const btn = (value: string, label: string, variant: "primary" | "secondary" = "secondary", icon?: "send" | "pen" | "mail" | "check") => (
    <Button name="op" value={value} variant={variant} icon={icon} disabled={pending} loading={pending && op === value} onClick={() => setOp(value)}>
      {label}
    </Button>
  );
  const buttons =
    status === "draft" ? [btn("send", "Send for signature", "primary", "send")]
    : open ? (inviteFailed ? [btn("resend", "Resend email", "primary", "send"), btn("remind", "Send reminder")] : [btn("remind", "Send reminder", "primary", "send"), btn("resend", "Resend email")])
    : status === "signed" ? (admin ? [btn("countersign", "Countersign and complete", "primary", "pen")] : [])
    : status === "expired" ? [btn("resend", "Reopen and resend", "primary", "send")]
    : status === "declined" ? [btn("resend", "Send again", "primary", "send")]
    : status === "completed" && canResendCopy ? [btn("resend_copy", "Resend signed copy", copyFailed ? "primary" : "secondary", "mail")]
    : [];
  const hasControls = buttons.length > 0 || (open && !!link);
  // after an action that leaves nothing more to do (countersigned, copy emailed), keep its result on screen
  if (!hasControls && !st) return null;
  return (
    <div className="space-y-3">
      {hasControls && (
        <form action={act} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="fileId" value={fileId} />
          {buttons}
          {open && link && <CopyButton text={link} label="Copy signing link" done="Link copied ✓" />}
        </form>
      )}
      {status === "signed" && admin && <p className="text-xs text-muted">Applies {countersigner}&apos;s adopted signature, seals the PDF and emails the client their copy.</p>}
      <div aria-live="polite">
        {st?.error && <Notice tone="error">{st.error}</Notice>}
        {st?.ok && <Notice tone="ok">{st.ok}</Notice>}
      </div>
    </div>
  );
}

/** Voiding is final, so it sits apart from the workflow actions and asks for a second click. */
export function VoidFile({ fileId }: { fileId: string }) {
  const [st, act, pending] = useActionState<FormState, FormData>(fileAction, undefined);
  const [voiding, setVoiding] = useState(false);
  return (
    <div className="space-y-2">
      {!voiding ? (
        <Button type="button" variant="danger" size="sm" onClick={() => setVoiding(true)}>
          Void
        </Button>
      ) : (
        <form action={act} className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <input type="hidden" name="fileId" value={fileId} />
          <p className="text-xs text-red-900">The signing link stops working at once and the file can&apos;t be reopened.</p>
          <input name="reason" aria-label="Reason for voiding" placeholder="Reason (optional, kept in the audit log)" className={inputCls} />
          <div className="flex flex-wrap gap-2">
            <Button name="op" value="void" variant="danger" size="sm" loading={pending}>
              Void file
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setVoiding(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div aria-live="polite">{st?.error && <Notice tone="error">{st.error}</Notice>}</div>
    </div>
  );
}
