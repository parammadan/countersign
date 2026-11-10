// M4 pipeline: an S7 intake record -> a routing decision -> verified workflow actions published through the
// outbox with idempotency keys -> an audit step for every stage. Pure rules, no model, no network.
import type { IntakeRecord } from "../intake/types";
import { payloadHash } from "./canonical";
import type { Outbox, PublishResult } from "./outbox";
import type { Target } from "./types";

export type PipelineAction = "review_task" | "prepare";
export const ACTION_EVENT: Record<PipelineAction, string> = {
  review_task: "intake.review_task.created",
  prepare: "intake.prepare.requested",
};

export interface PipelineInput {
  workspaceId: string;
  /** Id of the file (job or case) the document belongs to. */
  fileId: string;
  record: IntakeRecord;
}

export type Verified = { action: PipelineAction | null; decision: IntakeRecord["routing"]["decision"]; reasons: string[] };

export interface PipelineResult {
  /** Stable id of this intake record (hash of its content). */
  intakeId: string;
  decision: IntakeRecord["routing"]["decision"];
  /** The action that was verified and published, or null when none is allowed. */
  action: PipelineAction | null;
  reasons: string[];
  publish: PublishResult | null;
}

/**
 * Re-derives what the record permits instead of trusting `record.routing`: a record that claims
 * `ready_to_prepare` but carries missing fields, conflicts, warnings, injection or conformed signatures is
 * downgraded, and unsupported or injection-flagged documents never get an action.
 */
export function verifyRouting(rec: IntakeRecord): Verified {
  const arr = (x: unknown) => Array.isArray(x);
  if (!rec || rec.schema !== 1 || !rec.routing || !rec.documentType || !arr(rec.injection) || !arr(rec.missing) || !arr(rec.conflicts) || !arr(rec.warnings) || !arr(rec.signatureBlocks)) return { action: null, decision: "unsupported", reasons: ["malformed intake record"] };
  const t = rec.documentType.type;
  if (rec.pageCount === 0 || t === "other" || (t === "invoice" && !rec.documentType.ambiguous)) return { action: null, decision: "unsupported", reasons: ["unsupported document"] };
  if (rec.routing.decision === "unsupported") return { action: null, decision: "unsupported", reasons: ["intake routed the document as unsupported"] };
  if (rec.injection.length) return { action: null, decision: "needs_review", reasons: ["possible prompt injection: no automated action"] };
  const strict =
    rec.routing.decision === "ready_to_prepare" &&
    !rec.documentType.ambiguous && rec.documentType.decidedBy === "rules" && t !== "invoice" &&
    rec.missing.length === 0 && rec.conflicts.length === 0 && rec.warnings.length === 0 &&
    !rec.signatureBlocks.some((s) => s.value.style === "conformed");
  if (strict) return { action: "prepare", decision: "ready_to_prepare", reasons: ["all required fields found, no conflicts"] };
  // Fixed strings derived from the verified checks, never copied from the record.
  const reasons: string[] = [];
  if (rec.documentType.ambiguous) reasons.push("document type is ambiguous");
  if (rec.documentType.decidedBy === "model") reasons.push("type was chosen by a model");
  if (t === "invoice") reasons.push("may be an invoice");
  if (rec.warnings.length) reasons.push("input limits were hit");
  if (rec.signatureBlocks.some((s) => s.value.style === "conformed")) reasons.push("already carries conformed signatures");
  if (rec.conflicts.length) reasons.push(`${rec.conflicts.length} conflicting field(s)`);
  if (rec.missing.length) reasons.push(`${rec.missing.length} missing field(s)`);
  if (!reasons.length) reasons.push("needs human review");
  return { action: "review_task", decision: "needs_review", reasons };
}

export function intakeId(rec: IntakeRecord): string {
  return payloadHash(rec).slice(0, 32);
}

export function runPipeline(outbox: Outbox, input: PipelineInput, targets: Target[]): PipelineResult {
  const { workspaceId, fileId, record } = input;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(fileId)) throw new Error("fileId must be 1-64 characters of A-Z a-z 0-9 _ . -");
  let id: string;
  try {
    id = intakeId(record);
  } catch {
    id = payloadHash("unhashable").slice(0, 32);
  }
  const type = record?.documentType?.type ?? "other";
  outbox.recordStep(workspaceId, id, "intake_received", "ok", { fileId, documentType: type, pageCount: record?.pageCount ?? 0 });
  let v: Verified;
  try {
    v = verifyRouting(record);
  } catch {
    v = { action: null, decision: "unsupported", reasons: ["malformed intake record"] };
  }
  outbox.recordStep(workspaceId, id, "routed", v.decision, { claimed: record?.routing?.decision ?? null, verified: v.decision, action: v.action });
  if (!v.action) {
    outbox.recordStep(workspaceId, id, "no_action", "blocked", { reasons: v.reasons.length, injection: record?.injection?.length ?? 0 });
    return { intakeId: id, decision: v.decision, action: null, reasons: v.reasons, publish: null };
  }
  // Payload carries ids, type and generic reason strings only: never extracted quotes (which may be hostile text).
  const payload = { fileId, intakeId: id, documentType: type, decision: v.decision, reasons: v.reasons };
  const publish = outbox.publish({ workspaceId, type: ACTION_EVENT[v.action], payload, idempotencyKey: `m4:${fileId}:${id}:${v.action}` }, targets);
  outbox.recordStep(workspaceId, id, "published", publish.duplicate ? "duplicate" : "ok", { eventId: publish.event.id, action: v.action });
  return { intakeId: id, decision: v.decision, action: v.action, reasons: v.reasons, publish };
}
