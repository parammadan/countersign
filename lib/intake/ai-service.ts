// Document Intelligence with AI, for a session: Claude's analysis of one read document, and questions about it.
//
// Trust rules (the same as every other AI feature):
// - Every call takes the server session; the document is looked up in the session's workspace only (getIntake), so
//   another workspace's id is "not found". Any member may analyze and ask (reading only); nothing here changes the
//   document, its record, a draft or any file.
// - Every model call goes through aiGate + metered (lib/ai/budget): only a workspace whose owner confirmed their email,
//   within the server's, the workspace's and the new-workspace daily limits, each call reserved before and booked
//   after. Only the configured Anthropic provider (lib/ai/anthropic) is used.
// - Claude reads only the text the intake rules read, with quarantined lines blanked; a document whose injection scan
//   didn't finish is never sent to a model. Without AI the rules' reading (and passages, for questions) still work.
// - Questions use M2.2's answer, checks and second-pass verifier (lib/qa/store answerPages) over this document's pages.
import { tx } from "../db";
import { limited } from "../ratelimit";
import { verificationRequired } from "../emailverify";
import { id as newId } from "../util";
import { aiGate, aiState, estimateUsd, metered, MESSAGES, type AiState } from "../ai/budget";
import { configuredProvider, configuredVerifier } from "../ai/anthropic";
import { AnalysisError, type ModelProvider } from "../understand/model";
import { linesFromText } from "../understand/text";
import { cleanQuestion, QA_LIMITS, type QaResult, type Turn } from "../qa/answer";
import { answerPages, QA_DAILY, QA_PER_USER_PER_MINUTE } from "../qa/store";
import { analyzeDocumentWithModel, DOC_LIMITS } from "./ai";
import { getIntake, latestDocAnalysis, type SessionLike } from "./service";
import { analysesSince, finishQuestion, getModelPages, insertAnalysis, insertQuestion, ownThread, questionsSince, threadQuestions, threadsOf } from "./store";

/** A rough cost of one analysis, for deciding up front (each call is reserved at its real size). */
export const DOC_TYPICAL_USD = estimateUsd(20_000, DOC_LIMITS.maxOutputTokens);
const QA_TYPICAL_USD = estimateUsd(20_000, QA_LIMITS.maxOutputTokens);
export const ANALYSES_PER_HOUR = 20;
export const ANALYSES_PER_USER_PER_MINUTE = 3;

/** Why there is no AI for a document, beyond the workspace's AI state: no stored text, or an unfinished injection scan. */
export type DocAiReason = Exclude<AiState["reason"], undefined> | "no_text" | "scan_incomplete";
export type DocAi = { available: true } | { available: false; reason: DocAiReason };

/** Whether AI would run for this workspace now (no model call, nothing reserved): for showing the page. */
export function documentAiState(s: Pick<SessionLike, "workspaceId">, env: Record<string, string | undefined> = process.env): AiState {
  return aiState(s.workspaceId, configuredProvider(env) !== null, DOC_TYPICAL_USD, env);
}

/** The same, for one document: also needs its text, fully scanned for instructions aimed at an AI. */
export function documentAi(s: Pick<SessionLike, "workspaceId">, intakeId: string, env: Record<string, string | undefined> = process.env): DocAi {
  const text = getModelPages(s.workspaceId, intakeId);
  if (!text) return { available: false, reason: "no_text" };
  if (!text.complete) return { available: false, reason: "scan_incomplete" };
  const st = documentAiState(s, env);
  return st.available ? { available: true } : { available: false, reason: st.reason };
}

export type AnalyzeCode = "forbidden" | "invalid" | DocAiReason | "limit" | "failed";
export type AnalyzeResult = { ok: true; analysisId: string } | { ok: false; code: AnalyzeCode; message: string };

/** Fixed messages: nothing from the provider or the document is passed on. */
export const ANALYZE_MESSAGE: Record<AnalyzeCode, string> = {
  forbidden: "Sign in to a workspace first.",
  invalid: "Document not found in this workspace.",
  off: "AI isn't configured on this server, so the document was read by rules only.",
  unverified: MESSAGES.unverified,
  spend_cap: "The AI assistant has reached today's spending limit, so the document was read by rules only.",
  no_text: "This document was read before AI analysis was available. Read it again to analyze it with AI.",
  scan_incomplete: "This document couldn't be fully checked for hidden instructions aimed at an AI, so it isn't sent to AI. The rules' reading is below.",
  limit: `This workspace has analyzed ${ANALYSES_PER_HOUR} documents with AI in the last hour, the current limit. Try again later.`,
  failed: "Claude didn't finish the analysis. Try again in a moment; the rules' reading is below.",
};
const failure = (code: AnalyzeCode): { ok: false; code: AnalyzeCode; message: string } => ({ ok: false, code, message: ANALYZE_MESSAGE[code] });
const inFlight = new Map<string, number>();

/** Claude reads the document; the checked analysis is stored (latest wins) and its cost booked. */
export async function analyzeIntake(s: SessionLike, intakeId: string, provider: ModelProvider | null = configuredProvider()): Promise<AnalyzeResult> {
  const g = getIntake(s, intakeId);
  if (!g.ok) return failure(g.code === "forbidden" ? "forbidden" : "invalid");
  const ws = s.workspaceId;
  const text = getModelPages(ws, g.result.id);
  if (!text) return failure("no_text");
  if (!text.complete) return failure("scan_incomplete");
  if (!provider) return failure("off");
  if (limited(`doc-ai-user:${s.userId}`, ANALYSES_PER_USER_PER_MINUTE, 60_000)) return failure("limit");
  // checked and reserved synchronously, so concurrent requests can't all pass the hourly limit
  const busy = inFlight.get(ws) ?? 0;
  if (analysesSince(ws, new Date(Date.now() - 3600_000).toISOString()) + busy >= ANALYSES_PER_HOUR) return failure("limit");
  const gate = aiGate("doc_intel", ws, provider, DOC_TYPICAL_USD);
  if (!gate.provider) return failure(gate.reason ?? "off");
  inFlight.set(ws, busy + 1);
  try {
    let analysis;
    try {
      analysis = await analyzeDocumentWithModel(gate.provider, linesFromText(text.pages), g.result.record);
    } catch (e) {
      if (!(e instanceof AnalysisError)) throw e;
      return failure(gate.capped() ? "spend_cap" : "failed");
    }
    const aid = newId("dai_");
    insertAnalysis(ws, { id: aid, intakeId: g.result.id, createdBy: s.userId, model: analysis.model, result: analysis });
    return { ok: true, analysisId: aid };
  } finally {
    const n = (inFlight.get(ws) ?? 1) - 1;
    if (n > 0) inFlight.set(ws, n);
    else inFlight.delete(ws);
  }
}

/** The latest analysis of a document in the session's workspace, or null. */
export function documentAnalysis(s: SessionLike, intakeId: string) {
  const g = getIntake(s, intakeId);
  return g.ok ? latestDocAnalysis(s.workspaceId, g.result.id) : null;
}

// ---------- chat with this document ----------

export type AskCode = "forbidden" | "notfound" | "question" | "thread" | "slow" | "limit" | "no_text";
export type AskResult = { ok: true; id: string; threadId: string } | { ok: false; code: AskCode };
export const DOC_THREAD_ID = /^dq_[A-Za-z0-9_-]{6,50}$/;

// the notes M2.2 shows when it answers from passages (components/qaPresentation matches them)
const NOTE = {
  unverified: () =>
    verificationRequired()
      ? "Confirm your email address to get AI answers. Until the workspace owner does, these are the most relevant passages instead."
      : "AI answers need a confirmed email address, and this server can't send confirmation emails yet, so these are the most relevant passages instead.",
  spendCap: "AI answers have reached today's spending limit, so these are the most relevant passages instead.",
  scan: "This document couldn't be fully checked for hidden instructions aimed at an AI, so it isn't sent to AI; these are the most relevant passages instead.",
};
const FAILED_NOTE = /couldn['’]t answer just now/i;

/**
 * A question about one read document (or a follow-up in one of the asker's own conversations about it), answered by
 * M2.2's pipeline over this document's pages: Claude with the checks and the verifier when the AI gate allows, else
 * the most relevant passages with the reason. Rate limits and the daily allowance are M2.2's.
 */
export async function askIntakeQuestion(
  s: SessionLike & { userEmail: string },
  intakeId: string,
  rawQuestion: string,
  threadId: string | null = null,
  provider: ModelProvider | null = configuredProvider(),
  verifier: ModelProvider | null = provider ? configuredVerifier() : null,
): Promise<AskResult> {
  const g = getIntake(s, intakeId);
  if (!g.ok) return { ok: false, code: g.code === "forbidden" ? "forbidden" : "notfound" };
  const ws = s.workspaceId;
  const docId = g.result.id;
  const question = cleanQuestion(typeof rawQuestion === "string" ? rawQuestion : "");
  if (!question) return { ok: false, code: "question" };
  if (threadId !== null && (!DOC_THREAD_ID.test(threadId) || !ownThread(ws, docId, threadId, s.userId))) return { ok: false, code: "thread" };
  if (limited(`qa-user:${s.userId}`, QA_PER_USER_PER_MINUTE, 60_000)) return { ok: false, code: "slow" };
  const text = getModelPages(ws, docId);
  if (!text) return { ok: false, code: "no_text" };

  const notes: string[] = [];
  let answerer: ModelProvider | null = null;
  let checker: ModelProvider | null = null;
  let capped = () => false;
  if (!text.complete) notes.push(NOTE.scan);
  else if (provider) {
    const gate = aiGate("doc_qa", ws, provider, QA_TYPICAL_USD);
    capped = gate.capped;
    if (gate.provider) {
      answerer = gate.provider;
      // the second check is a paid call too: reserved and booked the same way
      if (verifier) {
        const m = metered(verifier, { feature: "doc_qa", workspaceId: ws });
        checker = m.provider;
        const first = capped;
        capped = () => first() || m.capped();
      }
    } else if (gate.reason === "unverified") notes.push(NOTE.unverified());
    else if (gate.reason === "spend_cap") notes.push(NOTE.spendCap);
  }

  // the daily allowance is taken atomically before any work; a failed attempt still counts
  const qid = newId("dq_");
  const thread = threadId ?? qid;
  const accepted = tx(() => {
    const cap = answerer ? QA_DAILY.model : QA_DAILY.passages;
    if (questionsSince(ws, new Date(Date.now() - 86400_000).toISOString()) >= cap) return false;
    insertQuestion(ws, { id: qid, intakeId: docId, threadId: thread, question, userId: s.userId, email: s.userEmail });
    return true;
  });
  if (!accepted) return { ok: false, code: "limit" };

  const turns: Turn[] = threadId
    ? threadQuestions(ws, docId, threadId)
        .slice(-QA_LIMITS.maxHistoryTurns)
        .map((r) => {
          const res = JSON.parse(r.result_json) as QaResult;
          return { question: r.question, answer: res.status === "not_found" ? "Not found in the agreement." : res.answer };
        })
    : [];
  try {
    const a = await answerPages({ provider: answerer, verifier: checker, question, pages: linesFromText(text.pages), turns, title: g.result.filename ?? "Document", notes });
    // the limit was reached during the call: say so, not "couldn't answer"
    if (a.mode === "model_failed" && capped()) a.result.warnings = a.result.warnings.map((w) => (FAILED_NOTE.test(w) ? NOTE.spendCap : w));
    finishQuestion(ws, qid, a.mode, a.result);
    return { ok: true, id: qid, threadId: thread };
  } catch (e) {
    finishQuestion(ws, qid, "failed", {});
    throw e;
  }
}

export type DocTurn = { id: string; threadId: string; question: string; result: QaResult; askedBy: string; askedById: string; createdAt: string };

/** One conversation about a document in the session's workspace, oldest first. */
export function documentConversation(s: SessionLike, intakeId: string, threadId: string): DocTurn[] {
  const g = getIntake(s, intakeId);
  if (!g.ok || !DOC_THREAD_ID.test(threadId)) return [];
  return threadQuestions(s.workspaceId, g.result.id, threadId).map((r) => ({ id: r.id, threadId: r.thread_id, question: r.question, result: JSON.parse(r.result_json) as QaResult, askedBy: r.asked_email, askedById: r.asked_by, createdAt: r.created_at }));
}

/** Conversations about a document, most recent first. */
export function documentConversations(s: SessionLike, intakeId: string) {
  const g = getIntake(s, intakeId);
  if (!g.ok) return [];
  return threadsOf(s.workspaceId, g.result.id).map((t) => ({ id: t.id, firstQuestion: t.first, turns: t.turns, askedBy: t.asked_email, lastAt: t.last_at }));
}
