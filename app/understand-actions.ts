"use server";

// M2.1 document understanding: read an agreement version, and confirm or dismiss what was found. Admins only,
// like editing an agreement. Neither action changes the agreement, its fields or any client file.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { analyzeVersion, reviewFinding, type Decision } from "@/lib/understand/store";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
const page = (versionId: string, q = "") => `/app/agreements/${encodeURIComponent(versionId)}/understand${q}`;

export async function analyzeAgreementAction(fd: FormData) {
  const sess = await requireAdmin();
  const versionId = str(fd.get("versionId"));
  try {
    await analyzeVersion(sess.workspaceId, versionId, sess.userEmail);
  } catch (e) {
    if (e instanceof AppError) redirect(page(versionId, `?error=${encodeURIComponent(e.message)}`));
    throw e;
  }
  redirect(page(versionId, "?read=1"));
}

export async function reviewFindingAction(fd: FormData) {
  const sess = await requireAdmin();
  const versionId = str(fd.get("versionId"));
  try {
    const r = reviewFinding(sess.workspaceId, str(fd.get("analysisId")), str(fd.get("findingId")), str(fd.get("decision")) as Decision, sess.userEmail);
    // re-render the page in place (a redirect that only changes the #anchor wouldn't refetch it)
    revalidatePath(page(r.versionId));
  } catch (e) {
    if (e instanceof AppError) redirect(page(versionId, `?error=${encodeURIComponent(e.message)}`));
    throw e;
  }
}
