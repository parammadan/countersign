import { latestVersion, type VersionHistory } from "./history";
import { checkCommittedParties, describeDrift } from "./parties";
import { validateDraft } from "../doc-output/validate";

export type ApprovalStatus = "draft" | "pending_approval" | "approved" | "published";
export type Role = "viewer" | "editor" | "approver";
export type Actor = { userId: string; role: Role };
export type ApprovalSettings = { requireDistinctApprover: boolean };

export type ApprovalState = {
  readonly status: ApprovalStatus;
  /** Version the approval applies to. */
  readonly versionId: string;
  readonly lastEditor: string;
  readonly approvedBy?: string;
  readonly log: readonly { action: string; by: string; from: ApprovalStatus; to: ApprovalStatus }[];
};

export type RefusalCode =
  | "forbidden_role" | "invalid_transition" | "same_person" | "open_proposals" | "stale_version" | "published_is_final"
  | "party_check_missing" | "party_drift" | "not_renderable";
export type TransitionResult = { ok: true; state: ApprovalState } | { ok: false; code: RefusalCode; message: string };

export const newApproval = (versionId: string, editor: string): ApprovalState => ({ status: "draft", versionId, lastEditor: editor, log: [] });

const refuse = (code: RefusalCode, message: string): TransitionResult => ({ ok: false, code, message });
const go = (s: ApprovalState, action: string, by: string, to: ApprovalStatus, patch: Partial<ApprovalState> = {}): TransitionResult => ({
  ok: true,
  state: { ...s, ...patch, status: to, log: [...s.log, { action, by, from: s.status, to }] },
});
const canEdit = (a: Actor) => a.role === "editor" || a.role === "approver";

/** A new version was saved: any non-published document returns to draft and approval is cleared. */
export function recordEdit(s: ApprovalState, actor: Actor, versionId: string): TransitionResult {
  if (s.status === "published") return refuse("published_is_final", "a published document cannot be edited");
  if (!canEdit(actor)) return refuse("forbidden_role", "viewers cannot edit");
  const { approvedBy: _drop, ...rest } = s;
  void _drop;
  return go(rest as ApprovalState, "edit", actor.userId, "draft", { versionId, lastEditor: actor.userId });
}

export function submitForApproval(s: ApprovalState, actor: Actor): TransitionResult {
  if (s.status === "published") return refuse("published_is_final", "already published");
  if (s.status !== "draft") return refuse("invalid_transition", `cannot submit from ${s.status}`);
  if (!canEdit(actor)) return refuse("forbidden_role", "viewers cannot submit");
  return go(s, "submit", actor.userId, "pending_approval");
}

/**
 * Mandatory party-drift gate, fail closed. approve and publish run the check themselves, on `ctx.history`: its latest
 * version must be the version being approved or published, and it is compared with the history's first (generated or
 * uploaded) version. No history, an unfrozen history, a different latest version, or an error gives
 * `party_check_missing`; any drift gives `party_drift`. No caller-supplied flag or result can say "checked, no drift".
 * Residual trust (not a security boundary against a dishonest host): `ApprovalState` names a version only by id, so
 * the host must pass THIS document's real history (the same trust the stale-version check places in
 * `currentVersionId`; scope version ids by document), and the first version's `origin` is whatever the host recorded.
 * The frozen check catches mistakes (a copied or JSON-restored history), not forgery; rebuild a stored history by
 * replaying `commitVersion` / `rollbackTo` from the stored rows.
 */
export type PartyGateCtx = { currentVersionId: string; history: VersionHistory };
function partyGate(s: ApprovalState, ctx: PartyGateCtx): TransitionResult | null {
  const r = checkCommittedParties(ctx.history);
  if (!r.ok) return refuse("party_check_missing", r.reason);
  if (r.versionId !== s.versionId || r.versionId !== ctx.currentVersionId)
    return refuse("party_check_missing", "the history's latest version is not the version being approved");
  if (r.drift.length > 0) return refuse("party_drift", describeDrift(r.drift));
  // Render gate, fail closed: a version the renderer would refuse (bidi or control characters, duplicate numbers,
  // size limits, no locked clause, ...) cannot be approved or published, because a published document is final and
  // could then never be rendered or edited.
  try {
    validateDraft(latestVersion(ctx.history).doc);
  } catch (e) {
    return refuse("not_renderable", `the document cannot be rendered: ${(e as Error).message}`);
  }
  return null;
}

const noContext = (ctx: unknown) => (typeof ctx === "object" && ctx !== null ? null : refuse("party_check_missing", "no gate context"));

export function approve(s: ApprovalState, actor: Actor, settings: ApprovalSettings, ctx: PartyGateCtx): TransitionResult {
  const missing = noContext(ctx);
  if (missing) return missing;
  if (s.status === "published") return refuse("published_is_final", "already published");
  if (s.status !== "pending_approval") return refuse("invalid_transition", `cannot approve from ${s.status}`);
  if (actor.role !== "approver") return refuse("forbidden_role", "only an approver can approve");
  // Owner rule, not a setting: the approver is never the last editor, nor the author of any version of this draft
  // (a trivial edit or rollback by someone else must not let the author of a substantive change approve it).
  // `settings.requireDistinctApprover` is kept for compatibility but can no longer turn this off.
  void settings;
  if (actor.userId === s.lastEditor) return refuse("same_person", "the approver must differ from the last editor");
  const versions = (ctx as PartyGateCtx).history?.versions;
  if (Array.isArray(versions) && versions.some((v) => v?.author === actor.userId))
    return refuse("same_person", "the approver created or edited a version of this draft");
  if (ctx.currentVersionId !== s.versionId) return refuse("stale_version", "the document changed after it was submitted");
  const party = partyGate(s, ctx);
  if (party) return party;
  return go(s, "approve", actor.userId, "approved", { approvedBy: actor.userId });
}

/** Approver sends a pending document back to draft. */
export function requestChanges(s: ApprovalState, actor: Actor): TransitionResult {
  if (s.status === "published") return refuse("published_is_final", "already published");
  if (s.status !== "pending_approval") return refuse("invalid_transition", `cannot request changes from ${s.status}`);
  if (actor.role !== "approver") return refuse("forbidden_role", "only an approver can request changes");
  return go(s, "request_changes", actor.userId, "draft");
}

/** Editors and approvers may publish an approved version; approval itself is approver-only. */
export function publish(s: ApprovalState, actor: Actor, ctx: { openProposals: number } & PartyGateCtx): TransitionResult {
  const missing = noContext(ctx);
  if (missing) return missing;
  if (s.status === "published") return refuse("published_is_final", "already published");
  if (s.status !== "approved") return refuse("invalid_transition", `cannot publish from ${s.status}`);
  if (!canEdit(actor)) return refuse("forbidden_role", "viewers cannot publish");
  if (!Number.isSafeInteger(ctx.openProposals) || ctx.openProposals < 0)
    return refuse("open_proposals", "the open proposal count is missing or invalid");
  if (ctx.openProposals > 0) return refuse("open_proposals", `${ctx.openProposals} proposal(s) still open or conflicting`);
  if (ctx.currentVersionId !== s.versionId) return refuse("stale_version", "approval applies to a different version");
  const party = partyGate(s, ctx);
  if (party) return party;
  return go(s, "publish", actor.userId, "published");
}

/** Which actions the ApprovalBar should offer (UI hint only; the transition functions are the authority). */
export function availableActions(s: ApprovalState, actor: Actor, settings: ApprovalSettings, ctx: { openProposals: number } & PartyGateCtx) {
  const probe = (r: TransitionResult) => (r.ok ? { enabled: true as const } : { enabled: false as const, reason: r.message });
  return {
    submit: probe(submitForApproval(s, actor)),
    approve: probe(approve(s, actor, settings, ctx)),
    requestChanges: probe(requestChanges(s, actor)),
    publish: probe(publish(s, actor, ctx)),
  };
}
