// Asking questions about an agreement version: limits, the answer (Claude if configured, else passages),
// conversations and history. Every query is scoped to the session's workspace; the stored PDF is only read.
// Questions and answers are never logged; the audit trail records the mode, status, tokens and cost.
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
import { AnalysisError, type ModelProvider, type Usage } from "../understand/model";
import { configuredProvider } from "../ai/anthropic";
import { costMicroUsd } from "../ai/pricing";
import { answerFromPassages, answerWithModel, cleanQuestion, QA_LIMITS, QaModelError, type QaResult, type Turn } from "./answer";

export const QA_PER_USER_PER_MINUTE = 6;
/** Questions per workspace per 24 hours: tight when a paid model answers, generous for passages only. */
export const QA_DAILY = { model: 50, passages: 300 };
/** Spend on AI answers across all workspaces per 24 hours (USD); past it, answers fall back to passages. */
export const aiDailyBudgetUsd = (env: Record<string, string | undefined> = process.env) => {
  const v = Number(env.AI_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};
const COMPLETED = "('passages', 'model', 'model_failed')";

export type QaEntry = { id: string; threadId: string; question: string; result: QaResult; askedBy: string; createdAt: string };
export type QaThread = { id: string; firstQuestion: string; turns: number; askedBy: string; lastAt: string };

/** AI spend in the last 24 hours, all workspaces, in micro-dollars. */
export function aiSpentToday(): number {
  const since = new Date(Date.now() - 86400_000).toISOString();
  return one<{ n: number | null }>("SELECT SUM(cost_microusd) n FROM qa_answers WHERE created_at > ?", since)?.n ?? 0;
}

export async function askQuestion(
  wsId: string,
  versionId: string,
  user: { id: string; email: string },
  rawQuestion: string,
  provider: ModelProvider | null = configuredProvider(),
  threadId: string | null = null,
): Promise<string> {
  const { template, version } = getTemplateVersion(wsId, versionId);
  const question = cleanQuestion(rawQuestion);
  if (!question) throw new AppError("Ask a question of up to 500 characters.", 422);
  // a follow-up continues one of the asker's own conversations about this version
  if (threadId && !one(`SELECT 1 FROM qa_answers WHERE id = ? AND workspace_id = ? AND template_version_id = ? AND asked_by = ? AND COALESCE(thread_id, id) = id AND mode IN ${COMPLETED}`, threadId, wsId, version.id, user.email))
    throw new AppError("That conversation wasn't found.", 404);
  if (limited(`qa-user:${user.id}`, QA_PER_USER_PER_MINUTE, 60_000)) throw new AppError("You're asking quickly. Wait a minute and try again.", 429);
  if ((JSON.parse(version.pages_json) as unknown[]).length > MAX_PAGES) throw new AppError(`This agreement has more than ${MAX_PAGES} pages, more than we read.`, 422);
  const notes: string[] = [];
  if (provider && aiSpentToday() >= aiDailyBudgetUsd() * 1e6) {
    provider = null;
    notes.push("AI answers have reached today's spending limit, so these are the most relevant passages instead.");
  }
  // the daily allowance is taken atomically before any work, so concurrent askers can't overshoot it; a failed
  // attempt still counts (it may have cost a model call)
  const cap = provider ? QA_DAILY.model : QA_DAILY.passages;
  const qid = id("qa_");
  tx(() => {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const today = one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
    if (today >= cap) throw new AppError(`This workspace has asked ${cap} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);
    run("INSERT INTO qa_answers (id, workspace_id, template_version_id, question, result_json, mode, asked_by, created_at, thread_id) VALUES (?,?,?,?,?,?,?,?,?)", qid, wsId, version.id, question, "{}", "pending", user.email, now(), threadId ?? qid);
  });
  try {
    return await answerAndStore(qid, wsId, template.name, version, user, question, provider, threadId ? history(wsId, threadId, qid) : [], notes);
  } catch (e) {
    run("UPDATE qa_answers SET mode = 'failed' WHERE id = ?", qid);
    throw e;
  }
}

/** Earlier completed turns of a conversation, oldest first: what was asked and what was shown. */
function history(wsId: string, threadId: string, exclude: string): Turn[] {
  return all<{ question: string; result_json: string }>(
    `SELECT question, result_json FROM qa_answers WHERE workspace_id = ? AND thread_id = ? AND id != ? AND mode IN ${COMPLETED} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    wsId,
    threadId,
    exclude,
    QA_LIMITS.maxHistoryTurns,
  )
    .reverse()
    .map((r) => {
      const res = JSON.parse(r.result_json) as QaResult;
      return { question: r.question, answer: res.status === "not_found" ? "Not found in the agreement." : res.answer };
    });
}

async function answerAndStore(
  qid: string,
  wsId: string,
  templateName: string,
  version: ReturnType<typeof getTemplateVersion>["version"],
  user: { id: string; email: string },
  question: string,
  provider: ModelProvider | null,
  turns: Turn[],
  notes: string[],
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
  let billed: Usage | undefined;
  if (provider) {
    try {
      result = await answerWithModel(provider, question, pages, QA_LIMITS, { history: turns, title: templateName });
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
  result.warnings.unshift(...notes);

  const cost = provider ? costMicroUsd(provider.model, billed) : 0;
  run(
    "UPDATE qa_answers SET result_json = ?, mode = ?, input_tokens = ?, output_tokens = ?, cache_write_tokens = ?, cache_read_tokens = ?, cost_microusd = ? WHERE id = ? AND workspace_id = ?",
    JSON.stringify(result),
    mode,
    billed?.inputTokens ?? 0,
    billed?.outputTokens ?? 0,
    billed?.cacheWriteTokens ?? 0,
    billed?.cacheReadTokens ?? 0,
    cost,
    qid,
    wsId,
  );
  audit(wsId, null, "agreement.question_asked", user.email, {}, {
    template: templateName,
    version: version.version,
    mode,
    status: result.status,
    follow_up: turns.length > 0,
    input_tokens: billed?.inputTokens ?? 0,
    output_tokens: billed?.outputTokens ?? 0,
    cache_read_tokens: billed?.cacheReadTokens ?? 0,
    cost_usd: cost / 1e6,
  });
  return qid;
}

type Row = { id: string; thread_id: string | null; question: string; result_json: string; asked_by: string; created_at: string };
const entry = (r: Row): QaEntry => ({ id: r.id, threadId: r.thread_id ?? r.id, question: r.question, result: JSON.parse(r.result_json) as QaResult, askedBy: r.asked_by, createdAt: r.created_at });

export function recentAnswers(wsId: string, versionId: string, limit = 20): QaEntry[] {
  getTemplateVersion(wsId, versionId); // 404 for another workspace's version
  return all<Row>(
    `SELECT id, thread_id, question, result_json, asked_by, created_at FROM qa_answers WHERE workspace_id = ? AND template_version_id = ? AND mode IN ${COMPLETED} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    wsId,
    versionId,
    limit,
  ).map(entry);
}

/** One conversation, oldest turn first. */
export function conversation(wsId: string, versionId: string, threadId: string): QaEntry[] {
  getTemplateVersion(wsId, versionId);
  return all<Row>(
    `SELECT id, thread_id, question, result_json, asked_by, created_at FROM qa_answers WHERE workspace_id = ? AND template_version_id = ? AND COALESCE(thread_id, id) = ? AND mode IN ${COMPLETED} ORDER BY created_at, rowid LIMIT 50`,
    wsId,
    versionId,
    threadId,
  ).map(entry);
}

/** Conversations about a version, most recent first. */
export function conversations(wsId: string, versionId: string, limit = 20): QaThread[] {
  getTemplateVersion(wsId, versionId);
  return all<{ id: string; first: string; turns: number; asked_by: string; last_at: string }>(
    `SELECT COALESCE(thread_id, id) id, MIN(asked_by) asked_by, COUNT(*) turns, MAX(created_at) last_at,
       (SELECT q2.question FROM qa_answers q2 WHERE q2.id = COALESCE(q.thread_id, q.id)) first
     FROM qa_answers q WHERE workspace_id = ? AND template_version_id = ? AND mode IN ${COMPLETED}
     GROUP BY COALESCE(thread_id, id) ORDER BY last_at DESC LIMIT ?`,
    wsId,
    versionId,
    limit,
  ).map((r) => ({ id: r.id, firstQuestion: r.first, turns: r.turns, askedBy: r.asked_by, lastAt: r.last_at }));
}

/** Whether answers come from a model on this server (shown on the page; never the key). */
export function assistantMode(provider: ModelProvider | null = configuredProvider()) {
  return provider ? { kind: "model" as const, model: provider.model } : { kind: "passages" as const };
}
