"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field, Notice, inputCls, cx } from "@/components/ui";
import { readDocumentAction } from "@/app/intake-actions";

export function ReadDocument() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(kind: "upload" | "paste") {
    setError(null);
    const form = new FormData();
    if (kind === "upload") {
      const f = fileRef.current?.files?.[0];
      if (!f) return setError("Choose a file first.");
      form.set("file", f);
    } else {
      if (!text.trim()) return setError("Paste the document's text first.");
      form.set("text", text);
      if (title.trim()) form.set("title", title.trim());
    }
    start(async () => {
      const r = await readDocumentAction(form);
      if (!r.ok) return setError(r.message);
      router.push(`/app/documents/${r.id}`);
    });
  }

  return (
    <Card>
      <CardHeader title="Read a document" description="Upload a PDF or Word file, or paste its text. Rules read it (no AI): the type, the parties, dates, amounts and governing law, with conflicts and warnings. Nothing is sent anywhere." />
      <div className="space-y-5 px-5 py-4">
        <Field label="Upload a file" hint="PDF or Word, up to 1.9 MB.">
          <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.odt,.rtf" className={inputCls} aria-label="Document file" />
        </Field>
        <Button type="button" variant="secondary" icon="upload" onClick={() => submit("upload")} loading={pending}>Read the file</Button>
        <div className="border-t border-line pt-5" />
        <Field label="Or paste the text" hint="Separate pages with a form feed if you have them; up to 200,000 characters.">
          <textarea className={cx(inputCls, "min-h-40 font-mono text-[13px]")} value={text} maxLength={200000} onChange={(e) => setText(e.target.value)} aria-label="Document text" />
        </Field>
        <Field label="Name (optional)">
          <input className={inputCls} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Northwind services agreement" />
        </Field>
        <Button type="button" icon="files" onClick={() => submit("paste")} loading={pending}>Read the text</Button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
