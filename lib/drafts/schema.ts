// M2.3 drafts schema. The proposed migration 8 in lib/db.ts (owner-reserved) is exactly this string, so the store
// and its tests run against the same DDL the app will. Every table carries workspace_id; every query filters on the
// session's workspace. UNIQUE(draft_id, number) is the concurrency control for two editors committing at once.
export const DRAFTS_DDL = `
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'published')),
    last_editor TEXT NOT NULL REFERENCES users(id),
    approved_by TEXT REFERENCES users(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_version_id TEXT REFERENCES template_versions(id),
    CHECK (status != 'published' OR published_version_id IS NOT NULL),
    CHECK (approved_by IS NULL OR approved_by != last_editor)
  );
  CREATE INDEX drafts_ws ON drafts(workspace_id, updated_at);
  CREATE UNIQUE INDEX drafts_published_version ON drafts(published_version_id) WHERE published_version_id IS NOT NULL;
  CREATE TABLE draft_versions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    number INTEGER NOT NULL CHECK (number >= 1),
    doc_json TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('generated', 'upload', 'edit', 'rollback')),
    restored_from INTEGER,
    author TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE (draft_id, number)
  );
  CREATE INDEX draft_versions_ws ON draft_versions(workspace_id, draft_id, number);
  CREATE TABLE draft_proposals (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    base_version INTEGER NOT NULL,
    clause_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('replace', 'insert_after', 'delete', 'add_clause')),
    before_text TEXT NOT NULL,
    after_text TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'conflict', 'blocked')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    decided_by TEXT REFERENCES users(id),
    decided_at TEXT
  );
  CREATE INDEX draft_proposals_ws ON draft_proposals(workspace_id, draft_id, status);
  CREATE TABLE draft_approvals (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    version_number INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'request_changes', 'publish')),
    actor TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX draft_approvals_ws ON draft_approvals(workspace_id, draft_id, created_at);
`;

/**
 * The same DDL, idempotent, for creating the tables at first use until migration 8 lands in lib/db.ts (owner-reserved).
 * It never reads or writes PRAGMA user_version, so lib/db.ts's migration bookkeeping is untouched.
 */
export const DRAFTS_DDL_IF_NOT_EXISTS = DRAFTS_DDL
  .replace(/CREATE TABLE /g, "CREATE TABLE IF NOT EXISTS ")
  .replace(/CREATE UNIQUE INDEX /g, "CREATE UNIQUE INDEX IF NOT EXISTS ")
  .replace(/CREATE INDEX /g, "CREATE INDEX IF NOT EXISTS ");
