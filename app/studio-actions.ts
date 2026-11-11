"use server";

// M2.3 Agreement Studio actions. Every action takes the server session (never an id, role or workspace from the
// request) and goes through lib/drafts/service, which authorizes it and scopes it to the workspace.
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import * as svc from "@/lib/drafts/service";
import type { GenerateInput } from "@/lib/m23/m23-generate";

const id = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : "");
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : -1);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const path = (draftId: string) => `/app/studio/${encodeURIComponent(draftId)}`;
// A Clause Library reference on an added clause: an id, a version and string values only (the server re-renders it).
const libraryRef = (v: unknown): { library?: { id: string; version: number; values: Record<string, string> } } => {
  const l = v as { id?: unknown; version?: unknown; values?: unknown } | null | undefined;
  if (!l || typeof l !== "object" || typeof l.id !== "string" || typeof l.version !== "number" || !Number.isSafeInteger(l.version)) return {};
  const values = Object.fromEntries(
    Object.entries(l.values && typeof l.values === "object" ? l.values : {}).slice(0, 40)
      .filter(([, x]) => typeof x === "string").map(([k, x]) => [k.slice(0, 200), (x as string).slice(0, 2_000)]),
  );
  return { library: { id: id(l.id), version: l.version, values } };
};

export async function suggestAction(description: string) {
  const s = await requireSession();
  return svc.suggestFromDescription(s, text(description, 4_000));
}

export async function createDraftAction(input: GenerateInput) {
  const s = await requireSession();
  // the generator validates every field itself; only the shape is narrowed here
  const safe: GenerateInput = {
    kind: input?.kind,
    parties: Array.isArray(input?.parties) ? input.parties.slice(0, 2).map((p) => ({ role: text(p?.role, 40), name: text(p?.name, 200) })) : [],
    terms: Object.fromEntries(Object.entries(input?.terms ?? {}).slice(0, 30).map(([k, v]) => [text(k, 40), typeof v === "number" ? v : text(v, k === "services" ? 1_200 : 200)])), // a services list is longer
    ...(typeof input?.instructions === "string" && input.instructions.trim() && { instructions: text(input.instructions, 1_000) }),
  };
  const r = await svc.createDraft(s, safe);
  if (r.ok) revalidatePath("/app/studio");
  return r;
}

export async function editAction(draftId: string, expected: number, edit: svc.ClauseEdit) {
  const s = await requireSession();
  const e: svc.ClauseEdit | null =
    edit?.op === "replace_clause" ? { op: "replace_clause", clauseId: id(edit.clauseId), text: text(edit.text, 20_000) }
      : edit?.op === "add_clause" ? { op: "add_clause", after: id(edit.after), text: text(edit.text, 20_000), heading: text(edit.heading, 120), ...libraryRef(edit.library) }
        : edit?.op === "delete_clause" ? { op: "delete_clause", clauseId: id(edit.clauseId) }
          : null;
  if (!e) return { ok: false as const, code: "invalid", message: "Unknown edit." };
  const r = svc.editDraft(s, id(draftId), int(expected), e);
  if (r.ok) revalidatePath(path(id(draftId)));
  return r;
}

export async function rollbackAction(draftId: string, expected: number, to: number) {
  const s = await requireSession();
  const r = svc.rollbackDraft(s, id(draftId), int(expected), int(to));
  if (r.ok) revalidatePath(path(id(draftId)));
  return r;
}

export async function submitAction(draftId: string, version: number) {
  const s = await requireSession();
  const r = svc.submitDraft(s, id(draftId), int(version));
  revalidatePath(path(id(draftId)));
  return r;
}

export async function approveAction(draftId: string, version: number) {
  const s = await requireSession();
  const r = await svc.approveDraft(s, id(draftId), int(version));
  revalidatePath(path(id(draftId)));
  return r;
}

export async function requestChangesAction(draftId: string) {
  const s = await requireSession();
  const r = svc.requestChanges(s, id(draftId));
  revalidatePath(path(id(draftId)));
  return r;
}

export async function publishAction(draftId: string, version: number) {
  const s = await requireSession();
  const r = await svc.publishDraft(s, id(draftId), int(version));
  revalidatePath(path(id(draftId)));
  revalidatePath("/app/agreements");
  return r;
}

export async function exportAction(draftId: string, format: "pdf" | "docx") {
  const s = await requireSession();
  return svc.exportDraft(s, id(draftId), format === "docx" ? "docx" : "pdf");
}

export async function abortPublishAction(draftId: string) {
  const s = await requireSession();
  const r = svc.abortPublish(s, id(draftId));
  revalidatePath(path(id(draftId)));
  return r;
}
