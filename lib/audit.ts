import { all, run } from "./db";
import { now } from "./util";

export type AuditEvent = {
  seq: number;
  file_id: string | null;
  type: string;
  actor: string;
  ip: string | null;
  user_agent: string | null;
  data_json: string;
  created_at: string;
};

export function audit(
  workspaceId: string,
  fileId: string | null,
  type: string,
  actor: string,
  ctx: { ip?: string; ua?: string } = {},
  data: Record<string, unknown> = {},
) {
  run(
    "INSERT INTO audit_events (workspace_id, file_id, type, actor, ip, user_agent, data_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    workspaceId,
    fileId,
    type,
    actor,
    ctx.ip ?? null,
    ctx.ua?.slice(0, 300) ?? null,
    JSON.stringify(data),
    now(),
  );
}

export function fileEvents(fileId: string): AuditEvent[] {
  return all<AuditEvent>("SELECT * FROM audit_events WHERE file_id = ? ORDER BY seq", fileId);
}

export const EVENT_TEXT: Record<string, string> = {
  "file.created": "File created",
  "file.sent": "Agreement sent to client",
  "file.resent": "Agreement re-sent",
  "file.reminded": "Reminder sent",
  "file.viewed": "Client opened the agreement",
  "file.otp_sent": "Verification code emailed",
  "file.otp_verified": "Client verified their email code",
  "file.otp_failed": "Wrong verification code entered",
  "file.consented": "Client agreed to sign electronically",
  "file.signed": "Client signed",
  "file.countersigned": "Firm countersigned",
  "file.completed": "Completed and sealed",
  "file.declined": "Client declined",
  "file.voided": "Voided by firm",
  "file.expired": "Signing link expired",
  "file.downloaded": "Signed copy downloaded",
  "file.email_failed": "Email to client failed",
};
