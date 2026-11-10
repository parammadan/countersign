"use server";

// M3 Knowledge Hub: index the workspace's agreements, and ask a question across them. Any member may (reading
// only). The workspace and role come from the session alone; nothing in the form chooses them.
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { AppError } from "@/lib/files";
import { askAcrossAgreements, runIndex } from "@/lib/m3/store";

const PAGE = "/app/knowledge";

function code(e: AppError) {
  if (e.status === 429) return /minute/.test(e.message) ? "slow" : "limit";
  if (e.status === 422) return "question";
  return "failed";
}

export async function indexAgreementsAction(fd: FormData) {
  const sess = await requireSession();
  const force = fd.get("force") === "1";
  const templateId = typeof fd.get("templateId") === "string" ? (fd.get("templateId") as string).slice(0, 100) : "";
  let q: string;
  try {
    const o = await runIndex(sess, { force: force || !!templateId, templateId: templateId || undefined });
    q = `?indexed=${o.indexed}&unchanged=${o.unchanged}&removed=${o.removed}&failed=${o.failed.length}`;
  } catch (e) {
    if (e instanceof AppError) redirect(`${PAGE}?error=${e.status === 429 ? "indexslow" : "failed"}`);
    throw e;
  }
  redirect(PAGE + q);
}

export async function askAgreementsAction(fd: FormData) {
  const sess = await requireSession();
  const question = typeof fd.get("question") === "string" ? (fd.get("question") as string).slice(0, 2000) : "";
  let qid: string;
  try {
    qid = await askAcrossAgreements(sess, question);
  } catch (e) {
    if (e instanceof AppError) redirect(`${PAGE}?error=${code(e)}`);
    throw e;
  }
  redirect(`${PAGE}?asked=${encodeURIComponent(qid)}#${encodeURIComponent(qid)}`);
}
