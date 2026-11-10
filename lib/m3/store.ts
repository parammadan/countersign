// M3 for the app: the session's principal, per-document restrictions (a hook; none today), indexing, asking with
// limits and booked usage, and history. Callers pass the session itself (from requireSession); every query is
// scoped by its workspace. Questions and answers are never logged; the audit trail records mode, status and tokens.
import { all, one, run, tx } from "../db";
import { AppError } from "../files";
import { audit } from "../audit";
import { limited } from "../ratelimit";
import { id, now } from "../util";
import type { Session } from "../auth";
import { configuredProvider } from "../ai/anthropic";
import { AnalysisError, type ModelProvider } from "../understand/model";
import { cleanQuestion } from "../qa/answer";
import { QA_DAILY, QA_PER_USER_PER_MINUTE } from "../qa/store";
import { answerAcrossAgreements, M3ModelError, type M3Result } from "./answer";
import { appIndex } from "./db";
import { indexedVersions, indexWorkspace, workspaceAgreements, type IndexOutcome } from "./ingest";
import type { DocumentRef, User } from "./security/types";
import type { Index } from "./index/types";

/** Same allowances as M2.2: tight when a paid model answers, generous for passages only. */
export const M3_DAILY = QA_DAILY;
export const M3_PER_USER_PER_MINUTE = QA_PER_USER_PER_MINUTE;

export type Principal = Pick<Session, "userId" | "userEmail" | "workspaceId" | "role">;
export type M3Entry = { id: string; question: string; result: M3Result; askedBy: string; createdAt: string };

/** The security layer's user, from the session only: one membership, in the session's workspace, with its role. */
export function principalOf(s: Principal): User {
  return { id: s.userId, memberships: [{ workspaceId: s.workspaceId, role: s.role }] };
}

type RestrictionHook = (workspaceId: string, documentId: string) => DocumentRef["restrictions"];
const g = globalThis as unknown as { __m3Restrictions?: RestrictionHook | null };

/**
 * Document-level restrictions. None exist today, so every member may read every agreement of the workspace. Once a
 * hook is configured, a hook that throws makes the document unreadable (fail closed), and malformed values are
 * refused by the policy (S6 decideRead).
 */
export function setDocumentRestrictions(hook: RestrictionHook | null): void {
  g.__m3Restrictions = hook;
}
function restrictionsOf(workspaceId: string, documentId: string): DocumentRef["restrictions"] {
  const hook = g.__m3Restrictions;
  if (!hook) return undefined;
  try {
    return hook(workspaceId, documentId);
  } catch {
    return null as unknown as DocumentRef["restrictions"]; // malformed: denied by the policy
  }
}

/**
 * The index as the Knowledge Hub may read it: only agreements that are live in the workspace now (not archived or
 * deleted), and each only at its current version. Until the owner's publish/archive hooks re-index automatically, a
 * stale entry is simply not served (fail closed) until someone re-indexes.
 */
export function currentOnly(index: Index, wsId: string): Index {
  const current = new Map(workspaceAgreements(wsId).map((d) => [d.templateId, d.versionId]));
  const deny = () => {
    throw new Error("read-only view");
  };
  return {
    put: deny,
    supersede: deny,
    remove: deny,
    passagesFor(workspaceId, opts) {
      if (workspaceId !== wsId) return [];
      return index.passagesFor(workspaceId, opts).filter((p) => current.get(p.documentId) === p.versionId);
    },
  };
}

function titles(wsId: string): (documentId: string) => string | undefined {
  const m = new Map(all<{ id: string; name: string }>("SELECT id, name FROM templates WHERE workspace_id = ?", wsId).map((t) => [t.id, t.name]));
  return (documentId) => m.get(documentId);
}

export type IndexStatus = { agreements: { templateId: string; name: string; version: number; versionId: string; indexed: boolean; indexedAt?: string }[]; indexed: number; total: number };

export function indexStatus(wsId: string): IndexStatus {
  const have = indexedVersions(wsId);
  const agreements = workspaceAgreements(wsId).map((d) => {
    const h = have.get(d.templateId);
    return { templateId: d.templateId, name: d.name, version: d.version, versionId: d.versionId, indexed: h?.versionId === d.versionId, indexedAt: h?.indexedAt };
  });
  return { agreements, indexed: agreements.filter((a) => a.indexed).length, total: agreements.length };
}

/** Index (backfill) the session's workspace; `templateId` re-indexes one agreement. Any member may (reading only). */
export async function runIndex(s: Principal, o: { force?: boolean; templateId?: string } = {}): Promise<IndexOutcome> {
  if (limited(`m3-index:${s.workspaceId}`, 6, 60_000)) throw new AppError("Indexing was just run. Wait a minute and try again.", 429);
  const outcome = await indexWorkspace(s.workspaceId, o);
  audit(s.workspaceId, null, "agreements.indexed", s.userEmail, {}, { indexed: outcome.indexed, unchanged: outcome.unchanged, removed: outcome.removed, failed: outcome.failed.length });
  return outcome;
}

/** Ask across the session's agreements. Returns the stored question's id. */
export async function askAcrossAgreements(s: Principal, rawQuestion: string, provider: ModelProvider | null = configuredProvider()): Promise<string> {
  const question = cleanQuestion(rawQuestion);
  if (!question) throw new AppError("Ask a question of up to 500 characters.", 422);
  if (limited(`m3-user:${s.userId}`, M3_PER_USER_PER_MINUTE, 60_000)) throw new AppError("You're asking quickly. Wait a minute and try again.", 429);
  const index = appIndex();
  // the daily allowance is taken atomically before any work; a failed attempt still counts (it may have cost a call)
  const cap = provider ? M3_DAILY.model : M3_DAILY.passages;
  const qid = id("m3q_");
  tx(() => {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const today = one<{ n: number }>("SELECT COUNT(*) n FROM m3_questions WHERE workspace_id = ? AND created_at > ?", s.workspaceId, since)?.n ?? 0;
    if (today >= cap) throw new AppError(`This workspace has asked ${cap} questions in the last 24 hours, the current limit. Try again tomorrow.`, 429);
    run("INSERT INTO m3_questions (id, workspace_id, question, result_json, mode, asked_by, created_at) VALUES (?,?,?,?,?,?,?)", qid, s.workspaceId, question, "{}", "pending", s.userEmail, now());
  });
  const ctx = { user: principalOf(s), workspace: { id: s.workspaceId }, index: currentOnly(index, s.workspaceId), restrictions: restrictionsOf, title: titles(s.workspaceId) };
  let result: M3Result;
  let mode: string;
  try {
    try {
      result = await answerAcrossAgreements(ctx, question, provider);
      mode = result.mode === "model" ? "model" : "passages";
    } catch (e) {
      if (!(e instanceof AnalysisError)) throw e;
      // the assistant failed (timeout, refusal, outage): the extractive answer instead, and keep what it cost
      result = await answerAcrossAgreements(ctx, question, null);
      result.usage = e instanceof M3ModelError ? e.usage : undefined;
      result.warnings.unshift("The AI assistant couldn't answer just now, so these are the passages instead.");
      mode = "model_failed";
    }
  } catch (e) {
    run("UPDATE m3_questions SET mode = 'failed' WHERE id = ? AND workspace_id = ?", qid, s.workspaceId);
    throw e;
  }
  run(
    "UPDATE m3_questions SET result_json = ?, mode = ?, input_tokens = ?, output_tokens = ? WHERE id = ? AND workspace_id = ?",
    JSON.stringify(result),
    mode,
    result.usage?.inputTokens ?? 0,
    result.usage?.outputTokens ?? 0,
    qid,
    s.workspaceId,
  );
  audit(s.workspaceId, null, "agreements.question_asked", s.userEmail, {}, { scope: "workspace", mode, status: result.status, input_tokens: result.usage?.inputTokens ?? 0, output_tokens: result.usage?.outputTokens ?? 0 });
  return qid;
}

export function recentQuestions(wsId: string, limit = 20): M3Entry[] {
  appIndex();
  return all<{ id: string; question: string; result_json: string; asked_by: string; created_at: string }>(
    "SELECT id, question, result_json, asked_by, created_at FROM m3_questions WHERE workspace_id = ? AND mode IN ('passages', 'model', 'model_failed') ORDER BY created_at DESC, rowid DESC LIMIT ?",
    wsId,
    limit,
  ).map((r) => ({ id: r.id, question: r.question, result: JSON.parse(r.result_json) as M3Result, askedBy: r.asked_by, createdAt: r.created_at }));
}

export function assistantMode(provider: ModelProvider | null = configuredProvider()) {
  return provider ? { kind: "model" as const, model: provider.model } : { kind: "passages" as const };
}
