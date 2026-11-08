"use server";

// M2.2: ask a question about an agreement version, or a follow-up in one of your conversations about it. Any
// member of the workspace may ask (reading only). Nothing here changes the agreement, its fields or any client file.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { askQuestion } from "@/lib/qa/store";

const page = (versionId: string, q = "") => (versionId ? `/app/agreements/${encodeURIComponent(versionId)}/ask${q}` : "/app/agreements");

// errors travel as codes; the page shows only its own fixed messages
function code(e: AppError) {
  if (e.status === 429) return /minute/.test(e.message) ? "slow" : "limit";
  if (/conversation/.test(e.message)) return "thread";
  if (e.status === 404) return "notfound";
  if (/fingerprint/.test(e.message)) return "changed";
  if (e.status === 422) return /question/.test(e.message) ? "question" : "unreadable";
  return "failed";
}

export async function askAction(fd: FormData) {
  const sess = await requireSession();
  const str = (k: string, max: number) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).slice(0, max) : "");
  const versionId = str("versionId", 100);
  const question = str("question", 2000);
  const thread = str("threadId", 60);
  const threadId = /^qa_[A-Za-z0-9_-]{6,50}$/.test(thread) ? thread : null;
  let qid: string;
  try {
    qid = await askQuestion(sess.workspaceId, versionId, { id: sess.userId, email: sess.userEmail }, question, undefined, threadId);
  } catch (e) {
    if (e instanceof AppError) redirect(page(versionId, `?error=${code(e)}${threadId ? `&thread=${threadId}` : ""}`));
    throw e;
  }
  // a follow-up lands on the same URL with a new #anchor, which on its own doesn't re-render the page
  revalidatePath(page(versionId));
  redirect(page(versionId, `?thread=${encodeURIComponent(threadId ?? qid)}#${qid}`));
}
