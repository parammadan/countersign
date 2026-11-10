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

const g = globalThis as unknown as { __intakeDb?: DatabaseSync };

/** Columns added after the table first shipped: a table created by an earlier build gets them (ALTER TABLE ADD COLUMN). */
const ADDED_COLUMNS: [string, string][] = [
  ["confirmed_by", "TEXT REFERENCES users(id)"],
  ["confirmed_at", "TEXT"],
  ["draft_id", "TEXT"],
];

/**
 * Create the intake table if missing and add any missing column, once per connection. Idempotent; the only pragma
 * is the read-only PRAGMA table_info, and PRAGMA user_version is never read or written.
 */
export function ensureIntakeSchema(conn: DatabaseSync = db()): void {
  if (g.__intakeDb === conn) return;
  conn.exec(INTAKE_DDL);
  const have = new Set((conn.prepare("PRAGMA table_info(intake_results)").all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) conn.exec(`ALTER TABLE intake_results ADD COLUMN ${name} ${type}`);
  g.__intakeDb = conn;
}

export type IntakeRow = { id: string; created_by: string; created_at: string; source: "upload" | "paste"; filename: string | null; doc_type: string; decision: RoutingDecision; confirmed_by: string | null; confirmed_at: string | null; draft_id: string | null };
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
