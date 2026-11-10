"use server";

// M4 Document Intelligence actions. Every action takes the server session (never an id, role or workspace from the
// request) and goes through lib/intake/service, which authorizes it and scopes it to the workspace.
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import * as svc from "@/lib/intake/service";

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
