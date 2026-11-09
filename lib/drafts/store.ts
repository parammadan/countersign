// M2.3 draft persistence over the DRAFTS_DDL tables (proposed migration 8). Nothing calls it yet.
//
// Every operation takes the server session's principal first and authorizes it with authorizeDraft (lib/drafts/roles):
// view and edit for owner, admin and staff; approve, request changes and publish for owner and admin only, approve by
// someone other than the last editor. Every read and write is scoped by the principal's workspace, and a draft in
// another workspace is `not_found`, the same as a missing one.
//
// State machine (each transition is one conditional UPDATE inside a transaction, so a race loses cleanly):
//   commit:          draft | pending_approval | approved -> draft      (a new version clears any approval)
//   submit:          draft -> pending_approval                         (the latest version only)
//   approve:         pending_approval -> approved                      (content check required)
//   request_changes: pending_approval -> draft
//   publish:         approved -> published                             (content check again; final)
// The content check (party drift, renderability, ...) is a required callback: approve and publish refuse without one,
// and refuse when it throws or says no. Versions are append-only; UNIQUE(draft_id, number) makes two editors who both
// commit on top of version N produce one version N+1 and one `stale`.
import type { DatabaseSync } from "node:sqlite";
import { authorizeDraft, principalFrom, type DraftAction, type Principal } from "./roles";
import { id as newId, now } from "../util";

export type DraftStatus = "draft" | "pending_approval" | "approved" | "published";
export type DraftRow = {
  id: string; workspace_id: string; kind: string; title: string; status: DraftStatus; last_editor: string;
  approved_by: string | null; created_by: string; created_at: string; updated_at: string; published_version_id: string | null;
};
export type VersionRow = { id: string; draft_id: string; number: number; doc: unknown; origin: string; author: string; created_at: string };

export type StoreError =
  | "unauthenticated" | "not_found" | "forbidden" | "same_person" | "stale" | "invalid_state" | "invalid" | "check_failed";
export type Result<T> = ({ ok: true } & T) | { ok: false; code: StoreError; message: string };

/** The content gate approve and publish run on the exact version. Must return { ok: true } to allow. */
export type ContentCheck = (doc: unknown) => { ok: true } | { ok: false; reason: string };

export const DRAFT_LIMITS = Object.freeze({ maxKind: 40, maxTitle: 300, maxDocBytes: 2_000_000 });

const fail = (code: StoreError, message: string): { ok: false; code: StoreError; message: string } => ({ ok: false, code, message });
const text = (v: unknown, max: number) => typeof v === "string" && v.trim() !== "" && v.length <= max;

function encodeDoc(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  let s: string;
  try {
    s = JSON.stringify(doc);
  } catch {
    return null;
  }
  return typeof s === "string" && Buffer.byteLength(s) <= DRAFT_LIMITS.maxDocBytes ? s : null;
}

export function draftStore(db: DatabaseSync) {
  const get1 = <T>(sql: string, ...p: (string | number | null)[]) => {
    const r = db.prepare(sql).get(...p);
    return r ? ({ ...r } as T) : undefined;
  };
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  /** The draft row, only from the principal's own workspace. */
  const rowFor = (p: Principal, draftId: unknown) =>
    typeof draftId === "string" ? get1<DraftRow>("SELECT * FROM drafts WHERE id = ? AND workspace_id = ?", draftId, p.workspaceId) : undefined;
  const latest = (p: Principal, draftId: string) =>
    get1<{ id: string; number: number; doc_json: string; origin: string; author: string; created_at: string }>(
      "SELECT id, number, doc_json, origin, author, created_at FROM draft_versions WHERE draft_id = ? AND workspace_id = ? ORDER BY number DESC LIMIT 1",
      draftId, p.workspaceId,
    );
  const log = (p: Principal, draftId: string, version: number, action: string, at: string) =>
    db.prepare("INSERT INTO draft_approvals (id, draft_id, workspace_id, version_number, action, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId("dap_"), draftId, p.workspaceId, version, action, p.userId, at);

  /** Authorize `action` on the draft; the draft's workspace and last editor come from the row, never from input. */
  function authorized(principal: unknown, draftId: unknown, action: DraftAction): Result<{ p: Principal; row: DraftRow }> {
    const p = principalFrom(principal);
    if (!p) return fail("unauthenticated", "Sign in to continue.");
    const row = rowFor(p, draftId);
    const a = authorizeDraft(p, row ? { workspaceId: row.workspace_id, lastEditor: row.last_editor } : null, action);
    if (!a.ok) return fail(a.code, a.message);
    return { ok: true, p, row: row! };
  }

  function runCheck(check: unknown, docJson: string): string | null {
    if (typeof check !== "function") return "no content check was supplied";
    try {
      const r = (check as ContentCheck)(JSON.parse(docJson));
      return r && r.ok === true ? null : (r && typeof r.reason === "string" ? r.reason : "the content check refused this version");
    } catch {
      return "the content check failed";
    }
  }

  /** One conditional transition; false when the row was not in `from` (a race or a stale view). */
  const move = (p: Principal, draftId: string, from: DraftStatus[], set: string, ...params: (string | null)[]) =>
    db.prepare(`UPDATE drafts SET ${set}, updated_at = ? WHERE id = ? AND workspace_id = ? AND status IN (${from.map(() => "?").join(", ")})`)
      .run(...params, now(), draftId, p.workspaceId, ...from).changes === 1;

  return {
    create(principal: unknown, input: { kind: unknown; title: unknown; doc: unknown; origin: "generated" | "upload" }): Result<{ draftId: string; number: 1 }> {
      const p = principalFrom(principal);
      if (!p) return fail("unauthenticated", "Sign in to continue.");
      const a = authorizeDraft(p, { workspaceId: p.workspaceId }, "edit");
      if (!a.ok) return fail(a.code, a.message);
      if (!text(input?.kind, DRAFT_LIMITS.maxKind) || !text(input?.title, DRAFT_LIMITS.maxTitle)) return fail("invalid", "A draft needs a kind and a title.");
      if (input.origin !== "generated" && input.origin !== "upload") return fail("invalid", "A draft starts as generated or uploaded.");
      const docJson = encodeDoc(input.doc);
      if (!docJson) return fail("invalid", "The draft content is missing or too large.");
      const draftId = newId("drf_");
      const at = now();
      tx(() => {
        db.prepare("INSERT INTO drafts (id, workspace_id, kind, title, status, last_editor, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)")
          .run(draftId, p.workspaceId, input.kind as string, input.title as string, p.userId, p.userId, at, at);
        db.prepare("INSERT INTO draft_versions (id, draft_id, workspace_id, number, doc_json, origin, author, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
          .run(newId("drv_"), draftId, p.workspaceId, docJson, input.origin, p.userId, at);
      });
      return { ok: true, draftId, number: 1 };
    },

    get(principal: unknown, draftId: unknown): Result<{ draft: DraftRow; version: VersionRow }> {
      const a = authorized(principal, draftId, "view");
      if (!a.ok) return a;
      const v = latest(a.p, a.row.id)!;
      return { ok: true, draft: a.row, version: { id: v.id, draft_id: a.row.id, number: v.number, doc: JSON.parse(v.doc_json), origin: v.origin, author: v.author, created_at: v.created_at } };
    },

    list(principal: unknown): Result<{ drafts: DraftRow[] }> {
      const p = principalFrom(principal);
      if (!p) return fail("unauthenticated", "Sign in to continue.");
      const a = authorizeDraft(p, { workspaceId: p.workspaceId }, "view");
      if (!a.ok) return fail(a.code, a.message);
      const drafts = db.prepare("SELECT * FROM drafts WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 500").all(p.workspaceId).map((r) => ({ ...r }) as DraftRow);
      return { ok: true, drafts };
    },

    /** Save a new version on top of `expected` (the number the editor started from). */
    commit(principal: unknown, draftId: unknown, input: { expected: unknown; doc: unknown; origin?: "edit" | "rollback"; restoredFrom?: number }): Result<{ number: number }> {
      const a = authorized(principal, draftId, "edit");
      if (!a.ok) return a;
      const { p, row } = a;
      if (row.status === "published") return fail("invalid_state", "A published draft is final.");
      if (!Number.isSafeInteger(input?.expected) || (input.expected as number) < 1) return fail("invalid", "The version being edited is missing.");
      const origin = input.origin ?? "edit";
      if (origin !== "edit" && origin !== "rollback") return fail("invalid", "Unknown version origin.");
      const docJson = encodeDoc(input.doc);
      if (!docJson) return fail("invalid", "The draft content is missing or too large.");
      const number = (input.expected as number) + 1;
      try {
        return tx(() => {
          const cur = latest(p, row.id)!;
          if (cur.number !== input.expected) return fail("stale", "Someone saved a newer version; reload and reapply your edits.");
          const at = now();
          db.prepare("INSERT INTO draft_versions (id, draft_id, workspace_id, number, doc_json, origin, restored_from, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(newId("drv_"), row.id, p.workspaceId, number, docJson, origin, origin === "rollback" ? (input.restoredFrom ?? null) : null, p.userId, at);
          if (!move(p, row.id, ["draft", "pending_approval", "approved"], "status = 'draft', last_editor = ?, approved_by = NULL", p.userId))
            throw new Error("state changed");
          return { ok: true as const, number };
        });
      } catch (e) {
        if (/UNIQUE|state changed/.test((e as Error).message)) return fail("stale", "Someone saved a newer version; reload and reapply your edits.");
        throw e;
      }
    },

    submit(principal: unknown, draftId: unknown, version: unknown): Result<object> {
      const a = authorized(principal, draftId, "edit");
      if (!a.ok) return a;
      return tx(() => {
        if (latest(a.p, a.row.id)!.number !== version) return fail("stale", "Submit the latest version.");
        if (!move(a.p, a.row.id, ["draft"], "status = 'pending_approval'")) return fail("invalid_state", "Only a draft can be submitted.");
        log(a.p, a.row.id, version as number, "submit", now());
        return { ok: true as const };
      });
    },

    approve(principal: unknown, draftId: unknown, version: unknown, check: ContentCheck): Result<object> {
      const a = authorized(principal, draftId, "approve");
      if (!a.ok) return a;
      return tx(() => {
        const v = latest(a.p, a.row.id)!;
        if (v.number !== version) return fail("stale", "The draft changed after it was submitted.");
        const refused = runCheck(check, v.doc_json);
        if (refused) return fail("check_failed", refused);
        if (!move(a.p, a.row.id, ["pending_approval"], "status = 'approved', approved_by = ?", a.p.userId))
          return fail("invalid_state", "Only a submitted draft can be approved.");
        log(a.p, a.row.id, v.number, "approve", now());
        return { ok: true as const };
      });
    },

    requestChanges(principal: unknown, draftId: unknown): Result<object> {
      const a = authorized(principal, draftId, "approve");
      if (!a.ok) return a;
      return tx(() => {
        if (!move(a.p, a.row.id, ["pending_approval"], "status = 'draft', approved_by = NULL")) return fail("invalid_state", "Only a submitted draft can be sent back.");
        log(a.p, a.row.id, latest(a.p, a.row.id)!.number, "request_changes", now());
        return { ok: true as const };
      });
    },

    /** Mark the approved version published, after the caller ingested it as agreement version `publishedVersionId`. */
    publish(principal: unknown, draftId: unknown, version: unknown, check: ContentCheck, publishedVersionId: unknown): Result<object> {
      const a = authorized(principal, draftId, "publish");
      if (!a.ok) return a;
      if (!text(publishedVersionId, 200)) return fail("invalid", "The published agreement version is missing.");
      return tx(() => {
        const v = latest(a.p, a.row.id)!;
        if (v.number !== version) return fail("stale", "The approval applies to a different version.");
        const refused = runCheck(check, v.doc_json);
        if (refused) return fail("check_failed", refused);
        if (!move(a.p, a.row.id, ["approved"], "status = 'published', published_version_id = ?", publishedVersionId as string))
          return fail("invalid_state", "Only an approved draft can be published.");
        log(a.p, a.row.id, v.number, "publish", now());
        return { ok: true as const };
      });
    },
  };
}
