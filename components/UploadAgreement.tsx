"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice, cx } from "./ui";
import { Icon } from "./icons";
import { ScanWithPhone } from "./scan/ScanWithPhone";

// Same rules the server enforces (lib/convert.ts, app/api/agreements/upload), checked first so a wrong file
// fails in a second instead of after the upload.
const ACCEPT = [".pdf", ".docx", ".doc", ".odt", ".rtf"];
const MAX_MB = 20;

type Phase = { kind: "idle" } | { kind: "uploading"; pct: number | null; name: string } | { kind: "reading"; name: string };

function check(file: File): string | null {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  if (!ACCEPT.includes(ext)) return `“${file.name}” isn't a PDF or Word document. Upload a .pdf, .docx, .doc, .odt or .rtf file.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_MB * 1024 * 1024) return `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB. Files up to ${MAX_MB} MB are supported.`;
  return null;
}

/** Real progress: bytes sent while uploading, then an honest "reading" state while the server converts and detects. */
function useUpload(templateId?: string) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [err, setErr] = useState<string | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);

  function start(file: File) {
    setErr(null);
    const bad = check(file);
    if (bad) return setErr(bad);
    const fd = new FormData();
    fd.append("file", file);
    if (templateId) fd.append("templateId", templateId);
    const x = new XMLHttpRequest();
    xhr.current = x;
    setPhase({ kind: "uploading", pct: 0, name: file.name });
    x.upload.onprogress = (e) => setPhase({ kind: "uploading", pct: e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null, name: file.name });
    x.upload.onload = () => setPhase({ kind: "reading", name: file.name });
    x.onload = () => {
      xhr.current = null;
      let j: { versionId?: string; error?: string } = {};
      try {
        j = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300 && j.versionId) return router.push(`/app/agreements/${j.versionId}`);
      setPhase({ kind: "idle" });
      setErr(j.error || (x.status === 413 ? `Files up to ${MAX_MB} MB are supported.` : `Upload failed (${x.status || "no response"}). Try again.`));
    };
    x.onerror = () => {
      xhr.current = null;
      setPhase({ kind: "idle" });
      setErr("The upload didn't reach the server. Check your connection and try again.");
    };
    x.onabort = () => {
      xhr.current = null;
      setPhase({ kind: "idle" });
      setErr(null);
    };
    x.open("POST", "/api/agreements/upload");
    x.send(fd);
  }

  return { phase, err, setErr, setPhase, start, cancel: () => xhr.current?.abort() };
}

function Progress({ phase, onCancel }: { phase: Exclude<Phase, { kind: "idle" }>; onCancel: () => void }) {
  return (
    <div className="w-full max-w-sm text-left" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{phase.name}</span>
        {phase.kind === "uploading" && (
          <button type="button" onClick={onCancel} className="shrink-0 text-xs font-medium text-muted hover:text-ink">
            Cancel
          </button>
        )}
      </div>
      {phase.kind === "uploading" ? (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.pct ?? undefined}>
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${phase.pct ?? 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted">{phase.pct === null ? "Uploading…" : `Uploading ${phase.pct}%`}</p>
        </>
      ) : (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden />
          Uploaded. Reading the agreement and finding where everyone signs; Word files are converted to PDF first.
        </p>
      )}
    </div>
  );
}

export function UploadAgreement({ templateId, compact }: { templateId?: string; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { phase, err, setErr, setPhase, start, cancel } = useUpload(templateId);
  const [over, setOver] = useState(false);
  const router = useRouter();
  const busy = phase.kind !== "idle";
  const picker = (
    <input
      ref={input}
      type="file"
      hidden
      accept={[...ACCEPT, "application/pdf"].join(",")}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) start(f);
      }}
    />
  );

  if (compact)
    return (
      <div className="flex flex-wrap items-center gap-3">
        {picker}
        {busy ? (
          <Progress phase={phase} onCancel={cancel} />
        ) : (
          <Button variant="secondary" size="sm" icon="upload" onClick={() => input.current?.click()}>
            Upload new version
          </Button>
        )}
        {err && <span className="text-sm text-bad" role="alert">{err}</span>}
      </div>
    );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (busy) return;
          const list = e.dataTransfer.files;
          if (list.length > 1) return setErr("Drop one agreement at a time.");
          if (list[0]) start(list[0]);
        }}
        data-testid="agreement-dropzone"
        className={cx(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
          over ? "border-brand bg-brand/5" : "border-line-strong bg-panel",
        )}
      >
        {picker}
        {busy ? (
          <Progress phase={phase} onCancel={cancel} />
        ) : (
          <>
            <span className={cx("flex h-11 w-11 items-center justify-center rounded-full", over ? "bg-brand text-white" : "bg-gray-100 text-ink-2")}>
              <Icon name="upload" size={20} />
            </span>
            <p className="mt-3 font-medium">{over ? "Drop to upload" : "Drag your agreement here"}</p>
            <p className="mt-1 text-sm text-muted">PDF or Word (.docx, .doc, .odt, .rtf), up to {MAX_MB} MB. We find where everyone signs, and you check it.</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => input.current?.click()}>Choose file</Button>
              {/* a paper agreement: photograph it with a phone instead (new agreements only, desktop widths) */}
              {!templateId && <ScanWithPhone />}
            </div>
            {!templateId && (
              <button
                type="button"
                className="mt-3 text-sm font-medium text-brand hover:underline"
                onClick={async () => {
                  setErr(null);
                  setPhase({ kind: "reading", name: "Sample engagement letter" });
                  const r = await fetch("/api/agreements/sample", { method: "POST" });
                  const j = (await r.json().catch(() => ({}))) as { versionId?: string; error?: string };
                  if (r.ok && j.versionId) return router.push(`/app/agreements/${j.versionId}`);
                  setErr(j.error || "Couldn't load the sample");
                  setPhase({ kind: "idle" });
                }}
              >
                No agreement handy? Try a sample one
              </button>
            )}
          </>
        )}
      </div>
      {err && (
        <div className="mt-3">
          <Notice tone="error">{err}</Notice>
        </div>
      )}
    </div>
  );
}
