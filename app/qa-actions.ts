"use server";

// M2.2: ask a question about an agreement version. Any member of the workspace may ask (reading only).
// Nothing here changes the agreement, its fields or any client file.
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { askQuestion } from "@/lib/qa/store";

const page = (versionId: string, q = "") => (versionId ? `/app/agreements/${encodeURIComponent(versionId)}/ask${q}` : "/app/agreements");

// errors travel as codes; the page shows only its own fixed messages
function code(e: AppError) {
  if (e.status === 429) return /minute/.test(e.message) ? "slow" : "limit";
  if (e.status === 404) return "notfound";
  if (/fingerprint/.test(e.message)) return "changed";
  if (e.status === 422) return /question/.test(e.message) ? "question" : "unreadable";
  return "failed";
}

export async function askAction(fd: FormData) {
  const sess = await requireSession();
  const versionId = typeof fd.get("versionId") === "string" ? (fd.get("versionId") as string).slice(0, 100) : "";
  const question = typeof fd.get("question") === "string" ? (fd.get("question") as string).slice(0, 2000) : "";
  let qid: string;
  try {
    qid = await askQuestion(sess.workspaceId, versionId, { id: sess.userId, email: sess.userEmail }, question);
  } catch (e) {
    // the question goes back in the URL (the page's own box, capped like the box), so it isn't lost
    if (e instanceof AppError) redirect(page(versionId, `?error=${code(e)}${question.trim() ? `&q=${encodeURIComponent(question.slice(0, 500))}` : ""}`));
    throw e;
  }
  redirect(page(versionId, `?asked=${encodeURIComponent(qid)}`));
}
