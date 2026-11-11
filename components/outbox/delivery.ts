import type { IconName } from "@/components/icons";
import { EMAIL_HELP } from "@/lib/email-guidance";

// How the email log reads a stored email: what kind it is and what happened to it. Pure helpers, shared by
// the list and the detail page, so both say exactly the same thing.

export type Delivery = "delivered" | "failed" | "logged";
export const DELIVERIES: readonly Delivery[] = ["delivered", "failed", "logged"];
export type DeliveryFilter = "all" | Delivery;

export type LoggedEmail = {
  id: string;
  file_id: string | null;
  kind: string;
  to_email: string;
  subject: string;
  status: string;
  created_at: string;
  error: string | null;
};

/** The `emails.status` column: "sent", "failed", or "logged" (recorded only, no provider configured). */
export function deliveryOf(status: string): Delivery {
  return status === "sent" ? "delivered" : status === "failed" ? "failed" : "logged";
}

export const DELIVERY: Record<Delivery, { label: string; filter: string; tone: "ok" | "bad" | "neutral"; icon: IconName; explain: string }> = {
  // "sent" means the mail server accepted it, not that it reached the inbox: never call it delivered
  delivered: { label: EMAIL_HELP.sent, filter: "Sent", tone: "ok", icon: "checkCircle", explain: EMAIL_HELP.sentExplain },
  failed: { label: "Failed", filter: "Failed", tone: "bad", icon: "error", explain: "The mail server refused it or couldn't be reached, so it wasn't delivered." },
  logged: { label: "Logged only", filter: "Logged only", tone: "neutral", icon: "info", explain: "Recorded here and not sent: email delivery wasn't configured when this was recorded." },
};

const KIND: Record<string, string> = {
  invite: "Invitation to sign",
  resend: "Invitation (sent again)",
  reminder: "Reminder",
  otp: "Verification code",
  completed: "Signed copy",
  firm_completed: "Firm: file completed",
  firm_ready: "Firm: countersignature needed",
  firm_declined: "Firm: client declined",
  invite_member: "Team invitation",
  password_reset: "Password reset",
  verify_email: "Email confirmation",
};

export function kindLabel(kind: string) {
  return KIND[kind] ?? kind.replace(/_/g, " ");
}

export function parseFilter(v: string | undefined): DeliveryFilter {
  return (DELIVERIES as readonly string[]).includes(v ?? "") ? (v as Delivery) : "all";
}
