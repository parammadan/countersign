"use client";

import { useActionState, useState } from "react";
import { fileAction, type FormState } from "@/app/actions";
import { Button, Notice, inputCls } from "./ui";
import type { FileStatus } from "@/lib/types";

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
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
        setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? "Copied ✓" : label}
    </Button>
  );
}

export function FileActions({ fileId, status, link, isAdmin, hasFinal }: { fileId: string; status: FileStatus; link: string | null; isAdmin: boolean; hasFinal: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(fileAction, undefined);
  const [voiding, setVoiding] = useState(false);
  const open = status === "sent" || status === "viewed";
  return (
    <div className="space-y-3">
      {st?.error && <Notice tone="error">{st.error}</Notice>}
      {st?.ok && <Notice tone="ok">{st.ok}</Notice>}
      <form action={act} className="flex flex-wrap gap-2">
        <input type="hidden" name="fileId" value={fileId} />
        {status === "draft" && <Button name="op" value="send" disabled={pending}>Send for signature</Button>}
        {status === "signed" && isAdmin && <Button name="op" value="countersign" disabled={pending}>Countersign and complete</Button>}
        {hasFinal && (
          <a href={`/api/files/${fileId}/document`} className="inline-flex items-center rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
            Download signed PDF
          </a>
        )}
        {open && <Button name="op" value="remind" variant="secondary" disabled={pending}>Send reminder</Button>}
        {(open || status === "expired") && <Button name="op" value="resend" variant="secondary" disabled={pending}>{status === "expired" ? "Reopen and resend" : "Resend email"}</Button>}
        {link && (open || status === "expired") && <CopyButton text={link} label="Copy signing link" />}
        {!["completed", "voided"].includes(status) && !voiding && (
          <Button type="button" variant="danger" onClick={() => setVoiding(true)}>Void</Button>
        )}
      </form>
      {voiding && (
        <form action={act} className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 sm:flex-row">
          <input type="hidden" name="fileId" value={fileId} />
          <input name="reason" placeholder="Reason (optional, kept in the audit log)" className={inputCls} />
          <div className="flex gap-2">
            <Button name="op" value="void" variant="danger" disabled={pending}>Void file</Button>
            <Button type="button" variant="ghost" onClick={() => setVoiding(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
