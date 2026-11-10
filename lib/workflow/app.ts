// The app's workflow outbox: S16's Outbox on the app database (countersign.db), internal only.
//
// External webhook delivery is DISABLED here, by construction:
// - the transport is the in-memory one and `externalDelivery` is false, so the Outbox refuses any network transport;
// - events are recorded with no targets, so there are no deliveries to attempt at all (nothing calls runDue);
// - the resolver refuses every lookup and no signing secret exists, so even a stray delivery could not be sent.
// The tables are created at first use, idempotently (OUTBOX_DDL: CREATE ... IF NOT EXISTS). PRAGMA user_version is
// never touched; docs/owner-patches/m4-intake-workflow-migration.patch adds them as a numbered migration.
// Every read and write is scoped by the workspace id, which callers take from the server session.
import type { DatabaseSync } from "node:sqlite";
import { all, db, one } from "../db";
import { MemoryTransport } from "./memory-transport";
import { Outbox, type PublishResult } from "./outbox";
import type { WorkflowEvent } from "./types";

export const EXTERNAL_DELIVERY = false as const;

const g = globalThis as unknown as { __wfOutbox?: { db: DatabaseSync; outbox: Outbox } };

export function appOutbox(): Outbox {
  const conn = db();
  if (g.__wfOutbox?.db !== conn) {
    const outbox = new Outbox({
      db: conn,
      transport: new MemoryTransport(),
      externalDelivery: EXTERNAL_DELIVERY,
      resolver: async () => {
        throw new Error("external delivery is disabled");
      },
      secretFor: () => undefined,
    });
    g.__wfOutbox = { db: conn, outbox };
  }
  return g.__wfOutbox.outbox;
}

/** Record one event for a workspace (no targets: nothing is delivered). The same key again is a no-op. */
export function recordEvent(workspaceId: string, type: string, payload: Record<string, unknown>, idempotencyKey: string): PublishResult {
  return appOutbox().publish({ workspaceId, type, payload, idempotencyKey }, []);
}

export type EventView = Pick<WorkflowEvent, "id" | "type" | "payload" | "createdAt"> & { delivery: "disabled" | "pending" | "delivered" | "failed" };

/** The workspace's events, newest first. With no targets every event shows delivery "disabled". */
export function listEvents(workspaceId: string, limit = 100): EventView[] {
  return appOutbox()
    .events(workspaceId, limit)
    .map((e) => ({
      id: e.id,
      type: e.type,
      payload: e.payload,
      createdAt: e.createdAt,
      delivery: e.deliveries === 0 ? "disabled" : e.dead > 0 ? "failed" : e.delivered === e.deliveries ? "delivered" : "pending",
    }));
}

const STUDIO_EVENT: Record<string, string> = {
  submit: "studio.draft.submitted",
  approve: "studio.draft.approved",
  request_changes: "studio.draft.changes_requested",
  publish: "studio.draft.published",
};

/**
 * Records Agreement Studio events (submitted, approved, changes requested, published) for a workspace from the Studio's
 * own approval log (draft_approvals), one event per log row, idempotently. The Studio's actions are left unchanged;
 * docs/owner-patches/m4-studio-events.patch proposes recording them at the moment they happen instead.
 */
export function syncStudioEvents(workspaceId: string): number {
  const exists = one<{ n: number }>("SELECT COUNT(*) n FROM sqlite_schema WHERE type = 'table' AND name IN ('draft_approvals', 'drafts')")?.n === 2;
  if (!exists) return 0;
  appOutbox(); // the wf_ tables exist before the query below joins them
  let added = 0;
  // only log rows that have no event yet (oldest first), in batches, so a long log is fully mirrored over time
  for (let round = 0; round < 40; round++) {
    const rows = all<{ id: string; draft_id: string; version_number: number; action: string; actor: string; created_at: string }>(
      `SELECT a.id, a.draft_id, a.version_number, a.action, a.actor, a.created_at
       FROM draft_approvals a
       JOIN drafts d ON d.id = a.draft_id AND d.workspace_id = a.workspace_id
       LEFT JOIN wf_events e ON e.workspace_id = a.workspace_id AND e.idempotency_key = 'studio:' || a.id
       WHERE a.workspace_id = ? AND e.id IS NULL AND a.action IN ('submit', 'approve', 'request_changes', 'publish')
       ORDER BY a.created_at, a.id LIMIT 500`,
      workspaceId,
    );
    for (const r of rows) {
      const res = recordEvent(workspaceId, STUDIO_EVENT[r.action], { draftId: r.draft_id, version: r.version_number, actorId: r.actor, at: r.created_at }, `studio:${r.id}`);
      if (!res.duplicate) added++;
    }
    if (rows.length < 500) break;
  }
  return added;
}
