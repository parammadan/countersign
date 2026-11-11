"use client";

// The question box (an agreement's Ask page, and chat on a read document). While the server works (Claude reading
// the document can take several seconds), the box and button are disabled and a status line says what's happening,
// announced to screen readers.
import { useFormStatus } from "react-dom";
import { Button, inputCls } from "@/components/ui";

function Controls({ followUp, ai, docWord }: { followUp: boolean; ai: boolean; docWord: string }) {
  const { pending } = useFormStatus();
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted" role="status" aria-live="polite">
        {pending ? (ai ? `Claude is reading the ${docWord} and checking its answer…` : "Finding the relevant passages…") : followUp ? "Follow-ups keep the context of this conversation." : ""}
      </p>
      <Button icon="spark" loading={pending}>{pending ? "Working…" : followUp ? "Ask a follow-up" : "Ask"}</Button>
    </div>
  );
}

function Box({ defaultValue, followUp, placeholder }: { defaultValue: string; followUp: boolean; placeholder?: string }) {
  const { pending } = useFormStatus();
  return (
    <textarea
      id="question"
      name="question"
      required
      minLength={3}
      maxLength={500}
      rows={2}
      readOnly={pending}
      aria-disabled={pending || undefined}
      defaultValue={defaultValue}
      placeholder={followUp ? "e.g. And what if the client pays late?" : (placeholder ?? "e.g. Can the client end the agreement early?")}
      className={inputCls + " h-auto py-2"}
    />
  );
}

/** `versionId` (an agreement version) or `hidden` (other identifying fields, e.g. a read document's id) go with the question. */
export function AskComposer({ action, versionId, hidden, threadId, defaultQuestion, ai, docWord = "agreement", placeholder }: { action: (fd: FormData) => void; versionId?: string; hidden?: Record<string, string>; threadId?: string; defaultQuestion: string; ai: boolean; docWord?: string; placeholder?: string }) {
  const followUp = Boolean(threadId);
  return (
    <form action={action} className="rounded-lg border border-line bg-white p-4 shadow-1">
      {versionId && <input type="hidden" name="versionId" value={versionId} />}
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {threadId && <input type="hidden" name="threadId" value={threadId} />}
      <label htmlFor="question" className="mb-1 block text-sm font-medium">{followUp ? "Follow-up question" : "Your question"}</label>
      <Box defaultValue={defaultQuestion} followUp={followUp} placeholder={placeholder} />
      <Controls followUp={followUp} ai={ai} docWord={docWord} />
    </form>
  );
}
