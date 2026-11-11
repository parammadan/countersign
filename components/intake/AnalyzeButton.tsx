"use client";

// Runs Claude's analysis of one read document (the server checks every point before storing it), then refreshes the
// page. While it works the button is disabled and a status line says what's happening, announced to screen readers.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice } from "@/components/ui";
import { analyzeDocumentAction } from "@/app/intake-actions";
import { DOC_AI_COPY } from "./ai-copy";

export function AnalyzeButton({ intakeId, again = false }: { intakeId: string; again?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function analyze() {
    setError(null);
    start(async () => {
      const r = await analyzeDocumentAction(intakeId);
      if (!r.ok) return setError(r.message);
      router.refresh();
    });
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" icon="spark" variant={again ? "secondary" : "primary"} size={again ? "sm" : "md"} onClick={analyze} loading={pending}>
          {again ? "Analyze again" : DOC_AI_COPY.analyze}
        </Button>
        <span className="text-xs text-muted" role="status" aria-live="polite">{pending ? DOC_AI_COPY.analyzing : ""}</span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
