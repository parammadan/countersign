"use server";

// M4 Document Intelligence actions. Every action takes the server session (never an id, role or workspace from the
// request) and goes through lib/intake/service, which authorizes it and scopes it to the workspace.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import * as svc from "@/lib/intake/service";
import { analyzeIntake, askIntakeQuestion, DOC_THREAD_ID, type AnalyzeResult } from "@/lib/intake/ai-service";
import type { GenerateInput } from "@/lib/m23/m23-generate";

export async function readDocumentAction(form: FormData): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const s = await requireSession();
  const file = form.get("file");
  const text = form.get("text");
  let r: Awaited<ReturnType<typeof svc.runIntake>>;
  if (file instanceof File && file.size > 0) {
    if (file.size > svc.MAX_INTAKE_UPLOAD) return { ok: false, message: "Files up to 1.9 MB can be read here. Paste the text instead, or save a smaller PDF." };
    r = await svc.runIntake(s, { kind: "upload", data: Buffer.from(await file.arrayBuffer()), filename: file.name || "document.pdf" });
  } else if (typeof text === "string" && text.trim()) {
    const title = form.get("title");
    r = await svc.runIntake(s, { kind: "paste", text, ...(typeof title === "string" && { title }) });
  } else return { ok: false, message: "Upload a file or paste the text." };
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/app/documents");
  return { ok: true, id: r.id };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Start a Studio draft from a read document, after the user confirmed the pre-filled values (recorded server-side). */
export async function startDraftAction(intakeId: string, input: GenerateInput, confirmed: boolean) {
  const s = await requireSession();
  // the generator validates every field itself; only the shape is narrowed here (as in createDraftAction)
  const safe: GenerateInput = {
    kind: input?.kind,
    parties: Array.isArray(input?.parties) ? input.parties.slice(0, 2).map((p) => ({ role: text(p?.role, 40), name: text(p?.name, 200) })) : [],
    terms: Object.fromEntries(Object.entries(input?.terms ?? {}).slice(0, 30).map(([k, v]) => [text(k, 40), typeof v === "number" ? v : text(v, 200)])),
  };
  const r = await svc.startDraftFromIntake(s, text(intakeId, 100), safe, confirmed === true);
  if (r.ok) {
    revalidatePath("/app/studio");
    revalidatePath(`/app/documents/${encodeURIComponent(text(intakeId, 100))}`);
  }
  return r;
}

/** Claude's analysis of a read document (checked against the document before it's stored). Any member may run it. */
export async function analyzeDocumentAction(intakeId: string): Promise<AnalyzeResult> {
  const s = await requireSession();
  const id = text(intakeId, 100);
  const r = await analyzeIntake(s, id);
  if (r.ok) revalidatePath(`/app/documents/${encodeURIComponent(id)}`);
  return r;
}

/** A question about one read document, or a follow-up in one of your own conversations about it. Errors travel as codes. */
export async function askDocumentAction(fd: FormData) {
  const s = await requireSession();
  const str = (k: string, max: number) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).slice(0, max) : "");
  const id = str("intakeId", 100);
  const thread = str("threadId", 60);
  const threadId = DOC_THREAD_ID.test(thread) ? thread : null;
  const base = `/app/documents/${encodeURIComponent(id)}`;
  const r = await askIntakeQuestion(s, id, str("question", 2000), threadId);
  if (!r.ok) {
    if (r.code === "notfound" || r.code === "forbidden") redirect("/app/documents");
    redirect(`${base}?chat_error=${r.code}${threadId ? `&thread=${threadId}` : ""}#chat`);
  }
  // a follow-up lands on the same URL with a new #anchor, which on its own doesn't re-render the page
  revalidatePath(base);
  redirect(`${base}?thread=${encodeURIComponent(r.threadId)}#${r.id}`);
}
