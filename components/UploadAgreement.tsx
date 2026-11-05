"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice, cx } from "./ui";

export function UploadAgreement({ templateId, compact }: { templateId?: string; compact?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function upload(file: File) {
    setErr(null);
    if (file.size > 20 * 1024 * 1024) return setErr("Files up to 20 MB are supported.");
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    if (templateId) fd.append("templateId", templateId);
    try {
      const r = await fetch("/api/agreements/upload", { method: "POST", body: fd });
      const j = (await r.json().catch(() => ({}))) as { versionId?: string; error?: string };
      if (!r.ok || !j.versionId) throw new Error(j.error || "Upload failed");
      router.push(`/app/agreements/${j.versionId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (compact)
    return (
      <>
        <input ref={input} type="file" hidden accept=".pdf,.docx,.doc,.odt,.rtf,application/pdf" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>{busy ? "Reading…" : "Upload new version"}</Button>
        {err && <span className="text-sm text-bad">{err}</span>}
      </>
    );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) upload(f);
        }}
        className={cx("flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition", over ? "border-brand bg-brand/5" : "border-gray-300 bg-white")}
      >
        <input ref={input} type="file" hidden accept=".pdf,.docx,.doc,.odt,.rtf,application/pdf" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {busy ? (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            <p className="mt-3 font-medium">Reading your agreement…</p>
            <p className="text-sm text-muted">Finding the signature, name and date lines.</p>
          </>
        ) : (
          <>
            <p className="font-medium">Drop your client agreement here</p>
            <p className="mt-1 text-sm text-muted">PDF or Word (.docx). We find where everyone signs, and you check it.</p>
            <Button className="mt-4" onClick={() => input.current?.click()}>Choose file</Button>
            <button
              type="button"
              className="mt-3 text-sm font-medium text-brand hover:underline"
              onClick={async () => {
                setBusy(true);
                setErr(null);
                const r = await fetch("/api/agreements/sample", { method: "POST" });
                const j = (await r.json().catch(() => ({}))) as { versionId?: string; error?: string };
                if (r.ok && j.versionId) router.push(`/app/agreements/${j.versionId}`);
                else {
                  setErr(j.error || "Couldn't load the sample");
                  setBusy(false);
                }
              }}
            >
              No agreement handy? Try a sample one
            </button>
          </>
        )}
      </div>
      {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
    </div>
  );
}
