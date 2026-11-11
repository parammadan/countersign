import { DatabaseSync } from "node:sqlite";
import { DRAFTS_DDL_IF_NOT_EXISTS } from "./drafts/schema";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    legal_name TEXT NOT NULL,
    brand_color TEXT NOT NULL DEFAULT '#1f4fd1',
    sender_name TEXT NOT NULL,
    reply_to TEXT,
    countersigner_name TEXT,
    countersigner_title TEXT,
    countersigner_email TEXT,
    countersign_image TEXT,
    auto_countersign INTEGER NOT NULL DEFAULT 1,
    reminder_days TEXT NOT NULL DEFAULT '2,5',
    expiry_days INTEGER NOT NULL DEFAULT 14,
    require_otp INTEGER NOT NULL DEFAULT 0,
    inbound_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    accepted_at TEXT
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    active_version_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE template_versions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES templates(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    version INTEGER NOT NULL,
    source_name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    pages_json TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    detection_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    template_version_id TEXT NOT NULL REFERENCES template_versions(id),
    ref TEXT,
    title TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_email TEXT NOT NULL,
    client_company TEXT,
    prefill_json TEXT NOT NULL DEFAULT '{}',
    client_values_json TEXT,
    status TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    token_enc TEXT,
    otp_hash TEXT,
    otp_expires_at TEXT,
    otp_attempts INTEGER NOT NULL DEFAULT 0,
    otp_verified_at TEXT,
    consent_at TEXT,
    sent_at TEXT,
    viewed_at TEXT,
    client_signed_at TEXT,
    completed_at TEXT,
    declined_at TEXT,
    decline_reason TEXT,
    voided_at TEXT,
    expires_at TEXT,
    reminders_sent INTEGER NOT NULL DEFAULT 0,
    last_reminder_at TEXT,
    source TEXT NOT NULL DEFAULT 'ui',
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX files_ws ON files(workspace_id, created_at);
  CREATE UNIQUE INDEX files_ref ON files(workspace_id, ref) WHERE ref IS NOT NULL;
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    file_id TEXT NOT NULL REFERENCES files(id),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX documents_sha ON documents(sha256);
  CREATE TABLE audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    file_id TEXT,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_file ON audit_events(file_id, seq);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id),
    workspace_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    response_code INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX deliveries_due ON webhook_deliveries(status, next_attempt_at);
  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    file_id TEXT,
    kind TEXT NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX emails_ws ON emails(workspace_id, created_at);
  `,
  `
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  `,
  `
  DROP INDEX files_ref;
  CREATE UNIQUE INDEX files_ref_live ON files(workspace_id, ref) WHERE ref IS NOT NULL AND status NOT IN ('voided','declined');
  `,
  // delivery result of the latest client email; email verification (existing accounts count as verified)
  `
  ALTER TABLE files ADD COLUMN email_status TEXT;
  ALTER TABLE files ADD COLUMN email_error TEXT;
  ALTER TABLE files ADD COLUMN copy_emailed_at TEXT;
  ALTER TABLE users ADD COLUMN email_verified_at TEXT;
  UPDATE users SET email_verified_at = created_at;
  CREATE TABLE email_verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // M2.1 document understanding: suggestions about an agreement version (never edited once written), and a
  // person's decision on each one. Confirmed findings are the verified facts; everything else stays a suggestion.
  `
  CREATE TABLE document_analyses (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    template_version_id TEXT NOT NULL REFERENCES template_versions(id),
    source_sha256 TEXT NOT NULL,
    analyzer TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX document_analyses_version ON document_analyses(workspace_id, template_version_id, created_at);
  CREATE TABLE finding_reviews (
    analysis_id TEXT NOT NULL REFERENCES document_analyses(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    finding_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
    reviewed_by TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (analysis_id, finding_id)
  );
  `,
  // M2.2 questions about an agreement: the question, the checked answer with its citations, and token usage
  `
  CREATE TABLE qa_answers (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    template_version_id TEXT NOT NULL REFERENCES template_versions(id),
    question TEXT NOT NULL,
    result_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    asked_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX qa_answers_version ON qa_answers(workspace_id, template_version_id, created_at);
  CREATE INDEX qa_answers_day ON qa_answers(workspace_id, created_at);
  `,
  // 7: M2.2 AI answers: conversations (a follow-up shares its first question's thread) and what each call cost,
  // including prompt-cache tokens. Additive; older code ignores the new columns.
  `
  ALTER TABLE qa_answers ADD COLUMN thread_id TEXT;
  ALTER TABLE qa_answers ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE qa_answers ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE qa_answers ADD COLUMN cost_microusd INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX qa_answers_thread ON qa_answers(workspace_id, thread_id, created_at);
  CREATE INDEX qa_answers_cost ON qa_answers(created_at, cost_microusd);
  `,
  // 8: M2.3 drafts (lib/drafts/schema.ts). IF NOT EXISTS: Agreement Studio may already have created these tables at
  // first use; a plain CREATE TABLE would fail here and take every db() call down.
  DRAFTS_DDL_IF_NOT_EXISTS,
  // 9: M3 knowledge search index (the sandbox's M3_INDEX_DDL, verbatim, so its openIndexOnDatabase schema check
  // accepts it). Not user-facing until the M3 evidence checks are validated.
  `
CREATE TABLE IF NOT EXISTS m3_versions (
  workspace_id TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','superseded')),
  binding      INTEGER NOT NULL CHECK (binding IN (0,1)),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, document_id, version_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS m3_one_active
  ON m3_versions (workspace_id, document_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS m3_passages (
  workspace_id TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  passage_id   TEXT NOT NULL,
  ord          INTEGER NOT NULL,
  page         INTEGER NOT NULL CHECK (page >= 1),
  text         TEXT NOT NULL,
  binding      INTEGER NOT NULL CHECK (binding IN (0,1)),
  flags        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, document_id, version_id, passage_id),
  FOREIGN KEY (workspace_id, document_id, version_id)
    REFERENCES m3_versions (workspace_id, document_id, version_id) ON DELETE CASCADE
) STRICT;
  `,
];

function open(): DatabaseSync {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "countersign.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

const g = globalThis as unknown as { __csdb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__csdb) g.__csdb = open();
  return g.__csdb;
}

type Param = string | number | null | bigint;

// node:sqlite rows have a null prototype; React won't pass those to client components.
export function one<T>(sql: string, ...params: Param[]): T | undefined {
  const r = db().prepare(sql).get(...params);
  return r ? ({ ...r } as T) : undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db()
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...r }) as T);
}

export function run(sql: string, ...params: Param[]) {
  return db().prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
