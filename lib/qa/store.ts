// Asking questions about an agreement version: limits, the answer (model if one is configured, else passages),
// and history. Every query is scoped to the session's workspace; the stored PDF is only read. Questions and
// answers are never logged; the audit trail records the mode, status and token counts.
import { all, one, run, tx } from "../db";
import { getTemplateVersion } from "../templates";
import { getBlob } from "../storage";
import { extractPdf } from "../pdf/extract";
import { AppError } from "../files";
import { audit } from "../audit";
import { limited } from "../ratelimit";
import { id, now, sha256 } from "../util";
import { pageLines } from "../understand/text";
import { latestAnalysis, MAX_PAGES } from "../understand/store";
import { AnalysisError, type ModelProvider } from "../understand/model";
import { configuredProvider } from "../ai/anthropic";
import { answerFromPassages, answerWithModel, cleanQuestion, QaModelError, type QaResult } from "./answer";

export const QA_PER_USER_PER_MINUTE = 6;
/** Questions per workspace per 24 hours: tight when a paid model answers, generous for passages only. */
export const QA_DAILY = { model: 50, passages: 300 };

export type QaEntry = { id: string; question: string; result: QaResult; askedBy: string; createdAt: string };

export async function askQuestion(
  wsId: string,
  versionId: string,
  user: { id: string; email: string },
  rawQuestion: string,
  provider: ModelProvider | null = configuredProvider(),
): Promise<string> {
  const { template, version } = getTemplateVersion(wsId, versionId);
  const question = cleanQuestion(rawQuestion);
  if (!question) throw new AppError("Ask a question of up to 500 characters.", 422);
  if (limited(`qa-user:${user.id}`, QA_PER_USER_PER_MINUTE, 60_000)) throw new AppError("You're asking quickly. Wait a minute and try again.", 429);
  if ((JSON.parse(version.pages_json) as unknown[]).length > MAX_PAGES) throw new AppError(`This agreement has more than ${MAX_PAGES} pages, more than we read.`, 422);
  // the daily allowance is taken atomically before any work, so concurrent askers can't overshoot it; a failed
  // attempt still counts (it may have cost a model call)
  const cap = provider ? QA_DAILY.model : QA_DAILY.passages;
  const qid = id("qa_");
  tx(() => {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const today = one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
    if (today >= cap) throw new AppError(`This workspace has asked ${cap} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);
    run("INSERT INTO qa_answers (id, workspace_id, template_version_id, question, result_json, mode, asked_by, created_at) VALUES (?,?,?,?,?,?,?,?)", qid, wsId, version.id, question, "{}", "pending", user.email, now());
  });
  try {
    return await answerAndStore(qid, wsId, template.name, version, user, question, provider);
  } catch (e) {
    run("UPDATE qa_answers SET mode = 'failed' WHERE id = ?", qid);
    throw e;
  }
}

async function answerAndStore(
  qid: string,
  wsId: string,
  templateName: string,
  version: ReturnType<typeof getTemplateVersion>["version"],
  user: { id: string; email: string },
  question: string,
  provider: ModelProvider | null,
): Promise<string> {
  const pdf = await getBlob(version.pdf_path);
  if (sha256(pdf) !== version.sha256) throw new AppError("The stored agreement doesn't match its fingerprint, so it wasn't read.", 409);
  let ex: Awaited<ReturnType<typeof extractPdf>>;
  try {
    ex = await extractPdf(new Uint8Array(pdf));
  } catch {
    throw new AppError("We couldn't read the text in this agreement.", 422);
  }
  const added = (JSON.parse(version.detection_json) as { addedSignaturePage?: boolean }).addedSignaturePage;
  const pages = pageLines(ex).slice(0, added && ex.pages.length > 1 ? -1 : undefined);
  // M2.1 findings someone dismissed aren't used
  const analysis = latestAnalysis(wsId, version.id);
  const findings = (analysis?.result.findings ?? []).filter((f) => analysis?.reviews[f.id]?.decision !== "dismissed");

  let result: QaResult;
  let mode = "passages";
  let billed: QaResult["usage"];
  if (provider) {
    try {
      result = await answerWithModel(provider, question, pages);
      mode = "model";
      billed = result.usage;
    } catch (e) {
      if (!(e instanceof AnalysisError)) throw e;
      // the assistant failed (timeout, refusal, bad output): show the relevant passages instead, and keep what
      // the failed call cost
      billed = e instanceof QaModelError ? e.usage : undefined;
      mode = "model_failed";
      result = answerFromPassages(question, pages, { findings });
      result.warnings.unshift("The AI assistant couldn't answer just now, so these are the most relevant passages instead.");
    }
  } else result = answerFromPassages(question, pages, { findings });

  run(
    "UPDATE qa_answers SET result_json = ?, mode = ?, input_tokens = ?, output_tokens = ? WHERE id = ? AND workspace_id = ?",
    JSON.stringify(result),
    mode,
    billed?.inputTokens ?? 0,
    billed?.outputTokens ?? 0,
    qid,
    wsId,
  );
  audit(wsId, null, "agreement.question_asked", user.email, {}, { template: templateName, version: version.version, mode, status: result.status, input_tokens: billed?.inputTokens ?? 0, output_tokens: billed?.outputTokens ?? 0 });
  return qid;
}

export function recentAnswers(wsId: string, versionId: string, limit = 20): QaEntry[] {
  getTemplateVersion(wsId, versionId); // 404 for another workspace's version
  return all<{ id: string; question: string; result_json: string; asked_by: string; created_at: string }>(
    "SELECT id, question, result_json, asked_by, created_at FROM qa_answers WHERE workspace_id = ? AND template_version_id = ? AND mode IN ('passages', 'model', 'model_failed') ORDER BY created_at DESC, rowid DESC LIMIT ?",
    wsId,
    versionId,
    limit,
  ).map((r) => ({ id: r.id, question: r.question, result: JSON.parse(r.result_json) as QaResult, askedBy: r.asked_by, createdAt: r.created_at }));
}

/** Whether answers come from a model on this server (shown on the page; never the key). */
export function assistantMode(provider: ModelProvider | null = configuredProvider()) {
  return provider ? { kind: "model" as const, model: provider.model } : { kind: "passages" as const };
}
