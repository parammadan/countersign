"use server";
// Hybrid drafting actions (behind HYBRID_DRAFTING). Inputs are narrowed here; the service checks the session's
// workspace, the person's role and the AI gate itself.
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import * as drafts from "@/lib/drafts/service";
import { reviewAiClause, runHybrid } from "@/lib/hybrid/service";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const id = (v: unknown) => text(v, 100);

export async function runHybridAction(draftId: string, description: string) {
  const s = await requireSession();
  const r = await runHybrid(s, id(draftId), text(description, 4_000), undefined, drafts);
  revalidatePath(`/app/studio/${encodeURIComponent(id(draftId))}`);
  return r.ok ? { ok: true as const, requirements: r.requirements, included: r.included, proposed: r.proposed } : { ok: false as const, message: r.message };
}

export async function reviewAiClauseAction(draftId: string, clauseId: string) {
  const s = await requireSession();
  const r = reviewAiClause(s, id(draftId), text(clauseId, 120), drafts);
  revalidatePath(`/app/studio/${encodeURIComponent(id(draftId))}`);
  return r;
}
