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
import { verificationRequired, workspaceVerified } from "../emailverify";
import { id, now, sha256 } from "../util";
import { pageLines } from "../understand/text";
import { latestAnalysis, MAX_PAGES } from "../understand/store";
import { AnalysisError, type ModelProvider, type Usage } from "../understand/model";
import { configuredProvider, configuredVerifier, TEST_KEY } from "../ai/anthropic";
import { costMicroUsd, worstCaseMicroUsd } from "../ai/pricing";
import { answerFromPassages, answerWithModel, cleanQuestion, modelContext, QA_LIMITS, QaModelError, requestTokens, tokensAtMost, type QaResult, type Turn } from "./answer";
import type { PageLines } from "../understand/text";
import type { Finding } from "../understand/schema";
import { VERIFY_JSON_SCHEMA, VERIFY_LIMITS, VERIFY_SYSTEM } from "./verify";

export const QA_PER_USER_PER_MINUTE = 6;
/** Questions per workspace per 24 hours: tight when a paid model answers, generous for passages only. */
export const QA_DAILY = { model: 50, passages: 300 };
/** Spend on AI answers across all workspaces per 24 hours (USD); past it, answers fall back to passages. */
export const aiDailyBudgetUsd = (env: Record<string, string | undefined> = process.env) => {
  const v = Number(env.AI_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 10;
};
/** Spend on AI answers per workspace per 24 hours (USD), so one workspace can't use up the global budget. */
export const aiWorkspaceDailyBudgetUsd = (env: Record<string, string | undefined> = process.env) => {
  const v = Number(env.AI_WORKSPACE_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 3;
};
/**
 * Spend on AI answers per 24 hours (USD) shared by all workspaces created in the last 7 days. Verifying an email
 * proves a mailbox, not a person: one inbox can verify many "+alias" sign-ups, so new workspaces together get a
 * smaller pool and can't use up the global budget that established customers rely on.
 */
export const aiNewWorkspaceDailyBudgetUsd = (env: Record<string, string | undefined> = process.env) => {
  const v = Number(env.AI_NEW_WORKSPACE_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 2;
};
export const NEW_WORKSPACE_DAYS = 7;
/**
 * Whether AI answers need a workspace whose owner confirmed their email. Always, whatever the email mode: with no
 * email provider (outbox) there is nothing to gate for mail, but model answers still cost money. Only the browser
 * tests, which sign up without a mailbox, turn it off, and only with the test key: a real key is never ungated.
 */
export const aiNeedsVerifiedWorkspace = (env: Record<string, string | undefined> = process.env) =>
  !(env.AI_ALLOW_UNVERIFIED_FOR_TESTS === "1" && env.ANTHROPIC_API_KEY === TEST_KEY);
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
  verifier: ModelProvider | null = provider ? configuredVerifier() : null,
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
  // a workspace past even the passages-only daily limit is turned away before the agreement is read
  const since0 = new Date(Date.now() - 86400_000).toISOString();
  if ((one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since0)?.n ?? 0) >= Math.max(QA_DAILY.model, QA_DAILY.passages))
    throw new AppError(`This workspace has asked ${Math.max(QA_DAILY.model, QA_DAILY.passages)} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);
  // the agreement is read first (no cost), so what each call will read is known before it's booked
  let read: { pages: PageLines[]; findings: Finding[] } | null = null;
  let readError: AppError | null = null;
  try {
    read = await readAgreement(wsId, version);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    readError = e;
  }
  const turns = threadId ? history(wsId, threadId, "") : [];
  // a model call is paid for before anyone knows its cost: its worst case (everything it reads written to the
  // cache, every output token, and a fallback attempt) is booked when the question is accepted, inside the same
  // transaction as the budget checks, and replaced by the real cost once the API reports it. A call that times out
  // keeps its worst case. With the verifier, both calls are booked: it reads the agreement plus the answer.
  const booked = provider && read ? reservation(provider, verifier, question, read.pages, turns) : { answer: 0, verify: 0 };
  const reserve = booked.answer + booked.verify;
  const qid = id("qa_");
  const useModel = tx(() => {
    const since = new Date(Date.now() - 86400_000).toISOString();
    let model = !!provider;
    // a sign-up gets a session straight away, so AI spend is only for workspaces whose owner confirmed their email
    // (the rule invites and outbound mail use); otherwise throwaway workspaces could use up everyone's budget
    if (model && aiNeedsVerifiedWorkspace() && !workspaceVerified(wsId)) {
      model = false;
      // in outbox mode no confirmation email is sent, so the owner has no way to confirm here
      notes.push(
        verificationRequired()
          ? "Confirm your email address to get AI answers. Until the workspace owner does, these are the most relevant passages instead."
          : "AI answers need a confirmed email address, and this server can't send confirmation emails yet, so these are the most relevant passages instead.",
      );
    }
    if (model) {
      const all = one<{ n: number | null }>("SELECT SUM(cost_microusd) n FROM qa_answers WHERE created_at > ?", since)?.n ?? 0;
      const mine = one<{ n: number | null }>("SELECT SUM(cost_microusd) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
      if (all + reserve > aiDailyBudgetUsd() * 1e6) {
        model = false;
        notes.push("AI answers have reached today's spending limit, so these are the most relevant passages instead.");
      } else if (mine + reserve > aiWorkspaceDailyBudgetUsd() * 1e6) {
        model = false;
        notes.push("This workspace has reached today's AI spending limit, so these are the most relevant passages instead.");
      } else {
        // workspaces created in the last week share one smaller pool (one mailbox can verify many sign-ups)
        const newSince = new Date(Date.now() - NEW_WORKSPACE_DAYS * 86400_000).toISOString();
        const isNew = !!one("SELECT 1 FROM workspaces WHERE id = ? AND created_at > ?", wsId, newSince);
        if (isNew) {
          const fresh = one<{ n: number | null }>("SELECT SUM(q.cost_microusd) n FROM qa_answers q JOIN workspaces w ON w.id = q.workspace_id WHERE q.created_at > ? AND w.created_at > ?", since, newSince)?.n ?? 0;
          if (fresh + reserve > aiNewWorkspaceDailyBudgetUsd() * 1e6) {
            model = false;
            notes.push("AI answers for new workspaces have reached today's limit, so these are the most relevant passages instead.");
          }
        }
      }
    }
    // the daily allowance is taken atomically before any work, so concurrent askers can't overshoot it; a failed
    // attempt still counts (it may have cost a model call)
    const cap = model ? QA_DAILY.model : QA_DAILY.passages;
    const today = one<{ n: number }>("SELECT COUNT(*) n FROM qa_answers WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
    if (today >= cap) throw new AppError(`This workspace has asked ${cap} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);
    run("INSERT INTO qa_answers (id, workspace_id, template_version_id, question, result_json, mode, asked_by, created_at, thread_id, cost_microusd) VALUES (?,?,?,?,?,?,?,?,?,?)", qid, wsId, version.id, question, "{}", "pending", user.email, now(), threadId ?? qid, model ? reserve : 0);
    return model;
  });
  if (!useModel) {
    provider = null;
    verifier = null;
  }
  // the agreement couldn't be read: the attempt counts toward the day's questions, and nothing was spent
  if (readError || !read) {
    run("UPDATE qa_answers SET mode = 'failed', cost_microusd = 0 WHERE id = ?", qid);
    throw readError ?? new AppError("We couldn't read the text in this agreement.", 422);
  }
  const state = { called: false };
  try {
    return await answerAndStore(qid, wsId, template.name, version, user, question, provider, verifier, turns, notes, booked, state, read);
  } catch (e) {
    // no model call was made: nothing was spent, so the reservation is released
    run("UPDATE qa_answers SET mode = 'failed', cost_microusd = CASE WHEN ? THEN cost_microusd ELSE 0 END WHERE id = ?", state.called ? 1 : 0, qid);
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

/** The worst case of each call, from what it will actually read. */
export function reservation(provider: ModelProvider, verifier: ModelProvider | null, question: string, pages: PageLines[], turns: Turn[]) {
  const input = requestTokens(modelContext(question, pages, QA_LIMITS, turns).shown);
  return {
    answer: worstCaseMicroUsd(provider.model, input, QA_LIMITS.maxOutputTokens),
    // the verifier reads the same agreement, the answer under review (no longer than the first call's output) and
    // its own prompt
    verify: verifier ? worstCaseMicroUsd(verifier.model, input + QA_LIMITS.maxOutputTokens + tokensAtMost(VERIFY_SYSTEM + JSON.stringify(VERIFY_JSON_SCHEMA)), VERIFY_LIMITS.maxOutputTokens) : 0,
  };
}

/** The agreement's text (the stored PDF, checked against its fingerprint) and the M2.1 findings nobody dismissed. */
export async function readAgreement(wsId: string, version: ReturnType<typeof getTemplateVersion>["version"]): Promise<{ pages: PageLines[]; findings: Finding[] }> {
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
  return { pages, findings };
}

async function answerAndStore(
  qid: string,
  wsId: string,
  templateName: string,
  version: ReturnType<typeof getTemplateVersion>["version"],
  user: { id: string; email: string },
  question: string,
  provider: ModelProvider | null,
  verifier: ModelProvider | null,
  turns: Turn[],
  notes: string[],
  booked: { answer: number; verify: number },
  state: { called: boolean },
  { pages, findings }: { pages: PageLines[]; findings: Finding[] },
): Promise<string> {

  let result: QaResult;
  let mode = "passages";
  let billed: Usage | undefined;
  let verifyBilled: Usage | undefined;
  if (provider) {
    state.called = true;
    try {
      result = await answerWithModel(provider, question, pages, QA_LIMITS, { history: turns, title: templateName, verifier });
      mode = "model";
      billed = result.usage;
      verifyBilled = result.verifyUsage;
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

  // the real cost when the API reported it; otherwise (timeout, network failure) the call may still have been
  // billed, so the worst case stays booked
  // both calls: the verifier's real cost when reported; a verifier call that failed without a report (timeout,
  // network) keeps its worst case booked, like the first
  const verifyCost = verifier && verifyBilled ? costMicroUsd(verifier.model, verifyBilled) : verifier && result.verifyCostUnknown ? booked.verify : 0;
  const cost = provider ? (billed ? costMicroUsd(provider.model, billed) + verifyCost : booked.answer) : 0;
  const tokens = (k: keyof Usage) => (Number(billed?.[k]) || 0) + (Number(verifyBilled?.[k]) || 0);
  run(
    "UPDATE qa_answers SET result_json = ?, mode = ?, input_tokens = ?, output_tokens = ?, cache_write_tokens = ?, cache_read_tokens = ?, cost_microusd = ? WHERE id = ? AND workspace_id = ?",
    JSON.stringify(result),
    mode,
    tokens("inputTokens"),
    tokens("outputTokens"),
    tokens("cacheWriteTokens"),
    tokens("cacheReadTokens"),
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
    verified: !!result.checks,
    input_tokens: tokens("inputTokens"),
    output_tokens: tokens("outputTokens"),
    cache_read_tokens: tokens("cacheReadTokens"),
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
