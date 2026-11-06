export type Workspace = {
  id: string;
  name: string;
  legal_name: string;
  brand_color: string;
  sender_name: string;
  reply_to: string | null;
  countersigner_name: string | null;
  countersigner_title: string | null;
  countersigner_email: string | null;
  countersign_image: string | null;
  auto_countersign: number;
  reminder_days: string;
  expiry_days: number;
  require_otp: number;
  inbound_token: string;
  created_at: string;
};

export type Template = {
  id: string;
  workspace_id: string;
  name: string;
  active_version_id: string | null;
  is_default: number;
  archived: number;
  created_at: string;
};

export type TemplateVersion = {
  id: string;
  template_id: string;
  workspace_id: string;
  version: number;
  source_name: string;
  source_path: string;
  pdf_path: string;
  sha256: string;
  pages_json: string;
  fields_json: string;
  detection_json: string;
  status: "draft" | "published";
  created_at: string;
  published_at: string | null;
};

export type FileStatus = "draft" | "sent" | "viewed" | "signed" | "completed" | "declined" | "voided" | "expired";

export type FileRow = {
  id: string;
  workspace_id: string;
  template_version_id: string;
  ref: string | null;
  title: string;
  client_name: string;
  client_email: string;
  client_company: string | null;
  prefill_json: string;
  client_values_json: string | null;
  status: FileStatus;
  token_hash: string | null;
  token_enc: string | null;
  otp_hash: string | null;
  otp_expires_at: string | null;
  otp_attempts: number;
  otp_verified_at: string | null;
  consent_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  client_signed_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  voided_at: string | null;
  expires_at: string | null;
  reminders_sent: number;
  last_reminder_at: string | null;
  source: string;
  created_by: string | null;
  created_at: string;
  /** result of the latest email to the client: sent | failed | logged (no provider configured) */
  email_status: "sent" | "failed" | "logged" | null;
  email_error: string | null;
  /** when the signed copy was emailed to the client */
  copy_emailed_at: string | null;
};

export const STATUS_LABEL: Record<FileStatus, string> = {
  draft: "Draft",
  sent: "Awaiting client",
  viewed: "Opened by client",
  signed: "Awaiting countersign",
  completed: "Completed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

export const OPEN_STATUSES: FileStatus[] = ["sent", "viewed"];
