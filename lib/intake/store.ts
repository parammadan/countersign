// Intake results, per workspace, in the app database. lib/db.ts is owner-reserved, so until the owner adds the
// table as a numbered migration (docs/owner-patches/m4-intake-workflow-migration.patch) it is created here at first
// use, idempotently (CREATE ... IF NOT EXISTS), on the app's own connection. PRAGMA user_version is never touched.
// Every query filters on the workspace id, which callers take from the server session.
import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run } from "../db";
import type { IntakeRecord, RoutingDecision } from "./types";

export const INTAKE_DDL = `
CREATE TABLE IF NOT EXISTS intake_results (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('upload', 'paste')),
  filename     TEXT,
  doc_type     TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('needs_review', 'ready_to_prepare', 'unsupported')),
  text_sha256  TEXT NOT NULL,
  record_json  TEXT NOT NULL,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  draft_id     TEXT
);
CREATE INDEX IF NOT EXISTS intake_results_ws ON intake_results (workspace_id, created_at);
`;

/**
 * Document Intelligence with AI: Claude's analysis of a read document (latest wins) and the questions asked about it.
 * Created with the intake table, the same way (IF NOT EXISTS, first use). Costs are booked in ai_spend (lib/ai/budget).
 */
export const INTAKE_AI_DDL = `
CREATE TABLE IF NOT EXISTS intake_ai_analyses (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  intake_id    TEXT NOT NULL REFERENCES intake_results(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  model        TEXT NOT NULL,
  result_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_ai_analyses_doc ON intake_ai_analyses (workspace_id, intake_id, created_at);
CREATE TABLE IF NOT EXISTS intake_questions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  intake_id    TEXT NOT NULL REFERENCES intake_results(id),
  thread_id    TEXT NOT NULL,
  question     TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  mode         TEXT NOT NULL,
  asked_by     TEXT NOT NULL REFERENCES users(id),
  asked_email  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_questions_doc ON intake_questions (workspace_id, intake_id, thread_id, created_at);
CREATE INDEX IF NOT EXISTS intake_questions_day ON intake_questions (workspace_id, created_at);
`;

const g = globalThis as unknown as { __intakeDb?: DatabaseSync };

/** Columns added after the table first shipped: a table created by an earlier build gets them (ALTER TABLE ADD COLUMN). */
const ADDED_COLUMNS: [string, string][] = [
  ["confirmed_by", "TEXT REFERENCES users(id)"],
  ["confirmed_at", "TEXT"],
  ["draft_id", "TEXT"],
  // the pages a model may read (quarantined lines blanked), and whether the injection scan finished (else no model)
  ["model_pages_json", "TEXT"],
  ["model_ok", "INTEGER"],
];

/**
 * Create the intake table if missing and add any missing column, once per connection. Idempotent; the only pragma
 * is the read-only PRAGMA table_info, and PRAGMA user_version is never read or written.
 */
export function ensureIntakeSchema(conn: DatabaseSync = db()): void {
  if (g.__intakeDb === conn) return;
  conn.exec(INTAKE_DDL);
  conn.exec(INTAKE_AI_DDL);
  const have = new Set((conn.prepare("PRAGMA table_info(intake_results)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) conn.exec(`ALTER TABLE intake_results ADD COLUMN ${name} ${type}`);
  g.__intakeDb = conn;
}

export type IntakeRow = { id: string; created_by: string; created_at: string; source: "upload" | "paste"; filename: string | null; doc_type: string; decision: RoutingDecision; confirmed_by: string | null; confirmed_at: string | null; draft_id: string | null };
export type IntakeResult = IntakeRow & { record: IntakeRecord };

export function insertResult(wsId: string, r: { id: string; createdBy: string; createdAt: string; source: "upload" | "paste"; filename: string | null; textSha256: string; record: IntakeRecord; modelPages?: { pages: string[]; complete: boolean } }): void {
  ensureIntakeSchema();
  run(
    "INSERT INTO intake_results (id, workspace_id, created_by, created_at, source, filename, doc_type, decision, text_sha256, record_json, model_pages_json, model_ok) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    r.id, wsId, r.createdBy, r.createdAt, r.source, r.filename, r.record.documentType.type, r.record.routing.decision, r.textSha256, JSON.stringify(r.record),
    r.modelPages ? JSON.stringify(r.modelPages.pages) : null, r.modelPages ? (r.modelPages.complete ? 1 : 0) : null,
  );
}

/**
 * The text of a read document that AI may use (quarantined lines blanked), for this workspace only. null for a
 * document read before AI support was added (no text was kept); `complete` false when it must not go to a model.
 */
export function getModelPages(wsId: string, id: string): { pages: string[]; complete: boolean } | null {
  ensureIntakeSchema();
  const r = one<{ p: string | null; ok: number | null }>("SELECT model_pages_json p, model_ok ok FROM intake_results WHERE id = ? AND workspace_id = ?", id, wsId);
  if (!r?.p) return null;
  return { pages: JSON.parse(r.p) as string[], complete: r.ok === 1 };
}

export function listResults(wsId: string, limit = 50): IntakeRow[] {
  ensureIntakeSchema();
  return all<IntakeRow>(
    "SELECT id, created_by, created_at, source, filename, doc_type, decision, confirmed_by, confirmed_at, draft_id FROM intake_results WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    wsId, Math.min(Math.max(1, Math.floor(limit)), 200),
  );
}

export function getResult(wsId: string, id: string): IntakeResult | null {
  ensureIntakeSchema();
  const r = one<IntakeRow & { record_json: string }>(
    "SELECT id, created_by, created_at, source, filename, doc_type, decision, confirmed_by, confirmed_at, draft_id, record_json FROM intake_results WHERE id = ? AND workspace_id = ?",
    id, wsId,
  );
  if (!r) return null;
  const { record_json, ...row } = r;
  return { ...row, record: JSON.parse(record_json) as IntakeRecord };
}

/** Provenance: who confirmed the pre-filled values, when, and the Studio draft that was started (latest wins). */
export function markDraftStarted(wsId: string, id: string, userId: string, draftId: string): void {
  ensureIntakeSchema();
  run("UPDATE intake_results SET confirmed_by = ?, confirmed_at = ?, draft_id = ? WHERE id = ? AND workspace_id = ?", userId, new Date().toISOString(), draftId, id, wsId);
}

/** Intake runs in this workspace since `sinceIso` (the per-workspace rate limit). */
export function runsSince(wsId: string, sinceIso: string): number {
  ensureIntakeSchema();
  return one<{ n: number }>("SELECT COUNT(*) n FROM intake_results WHERE workspace_id = ? AND created_at > ?", wsId, sinceIso)?.n ?? 0;
}

// ---------- AI analyses and questions (every query filters on the workspace) ----------

export type AnalysisRow = { id: string; intake_id: string; created_by: string; created_at: string; model: string; result_json: string };

export function insertAnalysis(wsId: string, r: { id: string; intakeId: string; createdBy: string; model: string; result: unknown }): void {
  ensureIntakeSchema();
  run(
    "INSERT INTO intake_ai_analyses (id, workspace_id, intake_id, created_by, created_at, model, result_json) VALUES (?,?,?,?,?,?,?)",
    r.id, wsId, r.intakeId, r.createdBy, new Date().toISOString(), r.model, JSON.stringify(r.result),
  );
}

export function latestAnalysisRow(wsId: string, intakeId: string): AnalysisRow | null {
  ensureIntakeSchema();
  return one<AnalysisRow>(
    "SELECT id, intake_id, created_by, created_at, model, result_json FROM intake_ai_analyses WHERE workspace_id = ? AND intake_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    wsId, intakeId,
  ) ?? null;
}

/** AI analyses in this workspace since `sinceIso` (the per-workspace rate limit). */
export function analysesSince(wsId: string, sinceIso: string): number {
  ensureIntakeSchema();
  return one<{ n: number }>("SELECT COUNT(*) n FROM intake_ai_analyses WHERE workspace_id = ? AND created_at > ?", wsId, sinceIso)?.n ?? 0;
}

export type QuestionRow = { id: string; thread_id: string; question: string; result_json: string; mode: string; asked_by: string; asked_email: string; created_at: string };
const Q_COLS = "id, thread_id, question, result_json, mode, asked_by, asked_email, created_at";
/** Questions that finished (answered, passages, or passages after a failed model call). */
const DONE = "('passages', 'model', 'model_failed')";

export function insertQuestion(wsId: string, r: { id: string; intakeId: string; threadId: string; question: string; userId: string; email: string }): void {
  ensureIntakeSchema();
  run(
    "INSERT INTO intake_questions (id, workspace_id, intake_id, thread_id, question, result_json, mode, asked_by, asked_email, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    r.id, wsId, r.intakeId, r.threadId, r.question, "{}", "pending", r.userId, r.email, new Date().toISOString(),
  );
}

export function finishQuestion(wsId: string, id: string, mode: string, result: unknown): void {
  ensureIntakeSchema();
  run("UPDATE intake_questions SET mode = ?, result_json = ? WHERE id = ? AND workspace_id = ?", mode, JSON.stringify(result), id, wsId);
}

/** Questions asked in this workspace since `sinceIso`, failed attempts included (the daily allowance). */
export function questionsSince(wsId: string, sinceIso: string): number {
  ensureIntakeSchema();
  return one<{ n: number }>("SELECT COUNT(*) n FROM intake_questions WHERE workspace_id = ? AND created_at > ?", wsId, sinceIso)?.n ?? 0;
}

/** Whether `threadId` is one of this user's own finished conversations about this document. */
export function ownThread(wsId: string, intakeId: string, threadId: string, userId: string): boolean {
  ensureIntakeSchema();
  return !!one(`SELECT 1 FROM intake_questions WHERE id = ? AND thread_id = id AND workspace_id = ? AND intake_id = ? AND asked_by = ? AND mode IN ${DONE}`, threadId, wsId, intakeId, userId);
}

/** One conversation about a document, oldest turn first. */
export function threadQuestions(wsId: string, intakeId: string, threadId: string, limit = 50): QuestionRow[] {
  ensureIntakeSchema();
  return all<QuestionRow>(
    `SELECT ${Q_COLS} FROM intake_questions WHERE workspace_id = ? AND intake_id = ? AND thread_id = ? AND mode IN ${DONE} ORDER BY created_at, rowid LIMIT ?`,
    wsId, intakeId, threadId, limit,
  );
}

/** The latest `n` finished turns of a conversation, oldest first (the context a follow-up is answered with). */
export function latestTurns(wsId: string, intakeId: string, threadId: string, n: number): QuestionRow[] {
  ensureIntakeSchema();
  return all<QuestionRow>(
    `SELECT ${Q_COLS} FROM intake_questions WHERE workspace_id = ? AND intake_id = ? AND thread_id = ? AND mode IN ${DONE} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    wsId, intakeId, threadId, n,
  ).reverse();
}

/** Conversations about a document, most recent first: first question, turns, who asked, when. */
export function threadsOf(wsId: string, intakeId: string, limit = 10): { id: string; first: string; turns: number; asked_email: string; last_at: string }[] {
  ensureIntakeSchema();
  return all(
    `SELECT thread_id id, COUNT(*) turns, MAX(created_at) last_at, MIN(asked_email) asked_email,
       (SELECT q2.question FROM intake_questions q2 WHERE q2.id = q.thread_id AND q2.workspace_id = q.workspace_id) first
     FROM intake_questions q WHERE workspace_id = ? AND intake_id = ? AND mode IN ${DONE}
     GROUP BY thread_id ORDER BY last_at DESC LIMIT ?`,
    wsId, intakeId, limit,
  );
}
