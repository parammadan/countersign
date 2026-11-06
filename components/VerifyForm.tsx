"use client";

import { useState } from "react";
import { Button, Notice } from "./ui";

type R = { match: boolean; sha256: string; kind?: string; title?: string; firm?: string; completed_at?: string; voided?: boolean; error?: string };

export function VerifyForm() {
  const [r, setR] = useState<R | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <form
        className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4 sm:flex-row sm:items-center"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
          if (!f) return;
          setBusy(true);
          const res = await fetch("/api/verify", { method: "POST", body: f, headers: { "Content-Type": "application/pdf" } });
          setR((await res.json()) as R);
          setBusy(false);
        }}
      >
        <input name="file" type="file" accept="application/pdf,.pdf" required className="min-w-0 flex-1 text-sm" />
        <Button disabled={busy}>{busy ? "Checking…" : "Verify"}</Button>
      </form>
      {r?.error && <Notice tone="error">{r.error}</Notice>}
      {r && !r.error && (r.match ? (
        <Notice tone="ok">
          <b>Authentic.</b> {r.kind} for “{r.title}”, sealed by Countersign for {r.firm}
          {r.completed_at ? ` on ${new Date(r.completed_at).toLocaleString()}` : ""}.
          {r.voided && <b> The sender has since voided this file.</b>}
          <div className="mt-1 break-all font-mono text-[11px] opacity-80">sha256 {r.sha256}</div>
        </Notice>
      ) : (
        <Notice tone="warn">
          <b>No match.</b> This exact file wasn&apos;t sealed by Countersign. It may have been changed after signing, or it&apos;s a different copy.
          <div className="mt-1 break-all font-mono text-[11px] opacity-80">sha256 {r.sha256}</div>
        </Notice>
      ))}
    </div>
  );
}
