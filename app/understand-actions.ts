"use server";

// M2.1 document understanding: read an agreement version, and confirm or dismiss what was found. Admins only,
// like editing an agreement. Neither action changes the agreement, its fields or any client file.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { analyzeVersion, reviewFinding, type Decision } from "@/lib/understand/store";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
const page = (versionId: string, q = "") => (versionId ? `/app/agreements/${encodeURIComponent(versionId)}/understand${q}` : "/app/agreements");
// errors travel as codes, so the page only ever shows its own fixed messages (never text from the URL)
function code(e: AppError) {
  if (e.status === 429) return "limit";
  if (e.status === 404) return "notfound";
  if (/fingerprint/.test(e.message)) return "changed";
  if (/read again/.test(e.message)) return "stale";
  if (/pages/.test(e.message)) return "toolong";
  if (e.status === 422) return "unreadable";
  return "failed";
}

export async function analyzeAgreementAction(fd: FormData) {
  const sess = await requireAdmin();
  const versionId = str(fd.get("versionId"));
  try {
    await analyzeVersion(sess.workspaceId, versionId, sess.userEmail);
  } catch (e) {
    if (e instanceof AppError) redirect(page(versionId, `?error=${code(e)}`));
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
    if (e instanceof AppError) redirect(page(versionId, `?error=${code(e)}`));
    throw e;
  }
}
