// Asking questions about an agreement version: limits, the answer (model if one is configured, else passages),
// and history. Every query is scoped to the session's workspace; the stored PDF is only read. Questions and
// answers are never logged; the audit trail records the mode, status and token counts.
import { all, one, run } from "../db";
import { getTemplateVersion } from "../templates";
import { getBlob } from "../storage";
import { extractPdf } from "../pdf/extract";
import { AppError } from "../files";
import { audit } from "../audit";
import { limited } from "../ratelimit";
import { id, now, sha256 } from "../util";
import { pageLines } from "../understand/text";
import { latestAnalysis } from "../understand/store";
import { AnalysisError, type ModelProvider } from "../understand/model";
import { configuredProvider } from "../ai/anthropic";
import { answerFromPassages, answerWithModel, cleanQuestion, type QaResult } from "./answer";

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
  const since = new Date(Date.now() - 86400_000).toISOString();
  const today = one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
  const cap = provider ? QA_DAILY.model : QA_DAILY.passages;
  if (today >= cap) throw new AppError(`This workspace has asked ${cap} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);

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
  const findings = latestAnalysis(wsId, version.id)?.result.findings ?? [];

  let result: QaResult;
  if (provider) {
    try {
      result = await answerWithModel(provider, question, pages);
    } catch (e) {
      if (!(e instanceof AnalysisError)) throw e;
      // the assistant failed (timeout, refusal, bad output): show the relevant passages instead
      result = answerFromPassages(question, pages, { findings });
      result.warnings.unshift("The AI assistant couldn't answer just now, so these are the most relevant passages instead.");
    }
  } else result = answerFromPassages(question, pages, { findings });

  const qid = id("qa_");
  run(
    "INSERT INTO qa_answers (id, workspace_id, template_version_id, question, result_json, mode, input_tokens, output_tokens, asked_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    qid,
    wsId,
    version.id,
    question,
    JSON.stringify(result),
    result.mode,
    result.usage?.inputTokens ?? 0,
    result.usage?.outputTokens ?? 0,
    user.email,
    now(),
  );
  audit(wsId, null, "agreement.question_asked", user.email, {}, { template: template.name, version: version.version, mode: result.mode, status: result.status, input_tokens: result.usage?.inputTokens ?? 0, output_tokens: result.usage?.outputTokens ?? 0 });
  return qid;
}

export function recentAnswers(wsId: string, versionId: string, limit = 20): QaEntry[] {
  getTemplateVersion(wsId, versionId); // 404 for another workspace's version
  return all<{ id: string; question: string; result_json: string; asked_by: string; created_at: string }>(
    "SELECT id, question, result_json, asked_by, created_at FROM qa_answers WHERE workspace_id = ? AND template_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    wsId,
    versionId,
    limit,
  ).map((r) => ({ id: r.id, question: r.question, result: JSON.parse(r.result_json) as QaResult, askedBy: r.asked_by, createdAt: r.created_at }));
}

/** Whether answers come from a model on this server (shown on the page; never the key). */
export function assistantMode(provider: ModelProvider | null = configuredProvider()) {
  return provider ? { kind: "model" as const, model: provider.model } : { kind: "passages" as const };
}
