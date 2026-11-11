"use client";

// Upload (or paste) one document, read it, and, when AI is available for this workspace, have Claude analyze it.
// The rules' reading always runs first; the analysis is a second step, so a failed or unavailable AI step still
// leaves the document read. "Try a sample agreement" sends the synthetic sample through exactly the same two steps.
import { useRef, useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Notice, inputCls, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { analyzeDocumentAction, readDocumentAction } from "@/app/intake-actions";
import { SAMPLE_AGREEMENT, SAMPLE_TITLE } from "@/lib/intake/sample";
import { fileProblem } from "@/lib/intake/limits";
import { DOC_AI_COPY as C } from "./ai-copy";

type Stage = "idle" | "reading" | "analyzing" | "opening";
const ACCEPT = ".pdf,.docx,.doc,.odt,.rtf";
const size = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

export function ReadDocument({ aiOn }: { aiOn: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [, startNav] = useTransition();
  const busy = stage !== "idle";

  // checked here with the server's own limits: a file over the request size limit would otherwise fail without its reason
  function pick(f: File | null | undefined) {
    setError(null);
    const problem = f ? fileProblem(f) : null;
    if (f && problem) {
      setError(`${f.name}: ${problem}`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(f ?? null);
  }
  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDrag(false);
    if (busy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) pick(f);
  }
  function clearFile() {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function run(form: FormData) {
    setError(null);
    setStage("reading");
    try {
      const r = await readDocumentAction(form);
      if (!r.ok) {
        setStage("idle");
        return setError(r.message);
      }
      let query = "";
      if (aiOn) {
        setStage("analyzing");
        const a = await analyzeDocumentAction(r.id);
        if (!a.ok) query = `?ai=${encodeURIComponent(a.code)}`;
      }
      setStage("opening");
      startNav(() => router.push(`/app/documents/${r.id}${query}`));
    } catch {
      setStage("idle");
      setError("Something went wrong while reading the document. Try again.");
    }
  }

  function submit() {
    const form = new FormData();
    if (file) form.set("file", file);
    else if (text.trim()) {
      form.set("text", text);
      if (title.trim()) form.set("title", title.trim());
    } else return setError("Choose a file or paste the document's text first.");
    void run(form);
  }

  function sample() {
    const form = new FormData();
    form.set("text", SAMPLE_AGREEMENT);
    form.set("title", SAMPLE_TITLE);
    void run(form);
  }

  const status = stage === "reading" ? C.reading : stage === "analyzing" ? C.analyzing : stage === "opening" ? C.opening : "";
  return (
    <Card>
      <div className="space-y-5 px-5 py-5">
        <label
          htmlFor="doc-file"
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={cx(
            "flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed px-5 py-8 text-center transition-colors focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15",
            drag ? "border-brand bg-brand-soft/50" : "border-line-strong bg-subtle hover:border-brand/50",
            busy && "pointer-events-none opacity-60",
          )}
        >
          <span className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand">
            <Icon name="upload" size={20} />
          </span>
          <span className="text-[15px] font-medium text-ink">
            {C.drop} <span className="text-brand underline underline-offset-2">{C.choose}</span>
          </span>
          <span className="max-w-md text-xs leading-relaxed text-muted">{C.fileHint}</span>
          <input ref={fileRef} id="doc-file" type="file" accept={ACCEPT} className="sr-only" aria-label="Document file" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {file && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <Icon name="files" size={16} className="shrink-0 text-muted" />
              <span className="truncate font-medium text-ink">{file.name}</span>
              <span className="shrink-0 text-xs text-muted">{size(file.size)}</span>
            </span>
            <Button type="button" variant="ghost" size="sm" icon="x" onClick={clearFile} disabled={busy} aria-label={`Remove ${file.name}`}>Remove</Button>
          </div>
        )}
        {file && text.trim() && <p className="-mt-3 text-xs text-muted">The file is read, not the pasted text. Remove the file to use the text instead.</p>}

        <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <Field label={C.pasteLabel} hint={C.pasteHint}>
          <textarea className={cx(inputCls, "min-h-36 font-mono text-[13px]")} value={text} maxLength={200000} onChange={(e) => setText(e.target.value)} aria-label="Document text" disabled={busy || !!file} placeholder={file ? "A file is chosen; remove it to paste text instead." : ""} />
        </Field>
        <Field label="Name (optional)">
          <input className={inputCls} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Northwind services agreement" disabled={busy || !!file} />
        </Field>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
          <Button type="button" size="lg" icon={aiOn ? "spark" : "files"} onClick={submit} loading={stage === "reading" || stage === "analyzing"} disabled={busy}>
            {aiOn ? C.analyze : C.rulesOnly}
          </Button>
          <Button type="button" variant="secondary" size="lg" icon="agreement" onClick={sample} disabled={busy}>{C.sample}</Button>
        </div>
        <p className="-mt-3 text-xs text-muted">{C.sampleHint}</p>
        <p className="min-h-5 text-sm text-ink-2" role="status" aria-live="polite">
          {status}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
