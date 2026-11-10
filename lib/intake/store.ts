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
  record_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_results_ws ON intake_results (workspace_id, created_at);
`;

const g = globalThis as unknown as { __intakeDb?: DatabaseSync };

/** Create the intake table if missing, once per connection (idempotent; no pragma). */
export function ensureIntakeSchema(conn: DatabaseSync = db()): void {
  if (g.__intakeDb === conn) return;
  conn.exec(INTAKE_DDL);
  g.__intakeDb = conn;
}

export type IntakeRow = { id: string; created_by: string; created_at: string; source: "upload" | "paste"; filename: string | null; doc_type: string; decision: RoutingDecision };
export type IntakeResult = IntakeRow & { record: IntakeRecord };

export function insertResult(wsId: string, r: { id: string; createdBy: string; createdAt: string; source: "upload" | "paste"; filename: string | null; textSha256: string; record: IntakeRecord }): void {
  ensureIntakeSchema();
  run(
    "INSERT INTO intake_results (id, workspace_id, created_by, created_at, source, filename, doc_type, decision, text_sha256, record_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    r.id, wsId, r.createdBy, r.createdAt, r.source, r.filename, r.record.documentType.type, r.record.routing.decision, r.textSha256, JSON.stringify(r.record),
  );
}

export function listResults(wsId: string, limit = 50): IntakeRow[] {
  ensureIntakeSchema();
  return all<IntakeRow>(
    "SELECT id, created_by, created_at, source, filename, doc_type, decision FROM intake_results WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    wsId, Math.min(Math.max(1, Math.floor(limit)), 200),
  );
}

export function getResult(wsId: string, id: string): IntakeResult | null {
  ensureIntakeSchema();
  const r = one<IntakeRow & { record_json: string }>(
    "SELECT id, created_by, created_at, source, filename, doc_type, decision, record_json FROM intake_results WHERE id = ? AND workspace_id = ?",
    id, wsId,
  );
  if (!r) return null;
  const { record_json, ...row } = r;
  return { ...row, record: JSON.parse(record_json) as IntakeRecord };
}

/** Intake runs in this workspace since `sinceIso` (the per-workspace rate limit). */
export function runsSince(wsId: string, sinceIso: string): number {
  ensureIntakeSchema();
  return one<{ n: number }>("SELECT COUNT(*) n FROM intake_results WHERE workspace_id = ? AND created_at > ?", wsId, sinceIso)?.n ?? 0;
}
