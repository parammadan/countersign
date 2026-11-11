import { db, one, run, tx } from "./db";
import { now, sha256, token } from "./util";
import type { Workspace } from "./types";

// Inbound webhook tokens are bearer credentials in a URL. Only sha256(token) is kept, in a table of
// its own (created here, so no migration is needed). `workspaces.inbound_token` is NOT NULL UNIQUE,
// so once a token is hashed the column holds a non-secret placeholder derived from the hash.
const MARK = "sha256:";
let ready = false;

function ensure() {
  if (ready) return;
  db().exec("CREATE TABLE IF NOT EXISTS inbound_tokens (workspace_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
  ready = true;
}

export const isHashedPlaceholder = (v: string) => v.startsWith(MARK);

function store(workspaceId: string, hash: string) {
  run("INSERT INTO inbound_tokens (workspace_id, token_hash, created_at) VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at", workspaceId, hash, now());
  run("UPDATE workspaces SET inbound_token = ? WHERE id = ?", MARK + hash, workspaceId);
}

// Resolve a URL token to its workspace. A legacy plaintext token is accepted and re-stored as a hash.
export function workspaceByInboundToken(raw: string): Workspace | undefined {
  ensure();
  if (!raw || raw.length > 200 || isHashedPlaceholder(raw)) return undefined;
  const hash = sha256(raw);
  const hit = one<Workspace>("SELECT w.* FROM inbound_tokens t JOIN workspaces w ON w.id = t.workspace_id WHERE t.token_hash = ?", hash);
  if (hit) return hit;
  return tx(() => {
    const legacy = one<Workspace>("SELECT * FROM workspaces WHERE inbound_token = ?", raw);
    if (legacy) store(legacy.id, hash);
    return legacy;
  });
}

// New token for a workspace; the caller shows it once. Returns the raw token.
export function rotateInboundToken(workspaceId: string): string {
  ensure();
  const t = token(18);
  tx(() => store(workspaceId, sha256(t)));
  return t;
}

// True when the workspace's URL can still be shown (an un-upgraded legacy token).
export function legacyInboundToken(ws: Workspace): string | null {
  return isHashedPlaceholder(ws.inbound_token) ? null : ws.inbound_token;
}
