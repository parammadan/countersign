// What the file page says, worked out from the file's real state. Pure functions: no database, no clock
// except the one passed in, so every rule can be tested.
import type { FileRow } from "./types";
import { EMAIL_HELP } from "./email-guidance";

export type StageState = "done" | "current" | "todo" | "stopped";
export type Stage = { key: string; label: string; at: string | null; state: StageState; note?: string };

const CLOSED = ["declined", "voided", "expired"] as const;
type Closed = (typeof CLOSED)[number];
const closedAt = (f: FileRow) => (f.status === "declined" ? f.declined_at : f.status === "voided" ? f.voided_at : f.status === "expired" ? f.expires_at : null);
const CLOSED_LABEL: Record<Closed, string> = { declined: "Declined by client", voided: "Voided", expired: "Link expired" };

/** Sent → opened → client signed → countersigned → ready for work. A closed file stops at the step it reached. */
export function fileStages(f: FileRow, ready: boolean): Stage[] {
  const steps: Omit<Stage, "state">[] = [
    { key: "sent", label: "Sent to client", at: f.sent_at },
    { key: "opened", label: "Opened", at: f.viewed_at ?? (f.client_signed_at ? f.client_signed_at : null) },
    { key: "signed", label: "Client signed", at: f.client_signed_at },
    { key: "countersigned", label: "Firm countersigned", at: f.completed_at },
    { key: "ready", label: "Ready for work", at: ready ? f.completed_at : null },
  ];
  const firstTodo = steps.findIndex((s) => !s.at);
  const closed = (CLOSED as readonly string[]).includes(f.status) ? (f.status as Closed) : null;
  return steps.map((s, i) => {
    if (s.at) return { ...s, state: "done" };
    if (closed && i === firstTodo) return { ...s, label: CLOSED_LABEL[closed], at: closedAt(f), state: "stopped" };
    if (closed && i > firstTodo) return { ...s, state: "todo" };
    return { ...s, state: i === firstTodo && f.status !== "draft" ? "current" : "todo" };
  });
}

export type ReminderPlan = { sent: number; planned: number; next: string | null; reason?: "off" | "done" | "expires_first" | "not_open" };

/** Mirrors the background worker: reminder n goes out reminder_days[n] days after sending, while the file is open. */
export function reminderPlan(f: FileRow, reminderDays: string): ReminderPlan {
  const days = reminderDays
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  const base = { sent: f.reminders_sent, planned: days.length };
  if (f.status !== "sent" && f.status !== "viewed") return { ...base, next: null, reason: "not_open" };
  if (!days.length) return { ...base, next: null, reason: "off" };
  const d = days[f.reminders_sent];
  if (d === undefined || !f.sent_at) return { ...base, next: null, reason: "done" };
  const next = new Date(new Date(f.sent_at).getTime() + d * 86400_000).toISOString();
  if (f.expires_at && next >= f.expires_at) return { ...base, next: null, reason: "expires_first" };
  return { ...base, next };
}

export type NextStep = { tone: "ok" | "info" | "warn" | "error" | "neutral"; title: string; body: string };

/** The one thing that needs to happen next on this file, and who has to do it. */
export function nextStep(
  f: FileRow,
  s: { admin: boolean; inviteFailed: boolean; inviteError?: string | null; ready: boolean; readinessProblem?: string; copyEmailed: boolean; copyFailed: boolean; outbox: boolean; autoCountersign: boolean },
): NextStep {
  const first = f.client_name.split(" ")[0] || f.client_name;
  switch (f.status) {
    case "draft":
      return { tone: "info", title: "Send the agreement to the client", body: `Nothing has gone to ${f.client_name} yet.` };
    case "sent":
    case "viewed":
      if (s.inviteFailed)
        return { tone: "error", title: `The email to ${first} wasn't delivered`, body: `${s.inviteError ? `The mail server said: ${s.inviteError}. ` : ""}The signing link still works. Resend the email, or copy the link and send it another way.` };
      return f.status === "sent"
        ? { tone: "info", title: `Waiting for ${first} to open the agreement`, body: s.outbox ? "Email delivery isn't configured on this server, so share the signing link yourself." : `The mail server accepted the signing email. ${EMAIL_HELP.client} Reminders go out on their own; you can also nudge them now.` }
        : { tone: "info", title: `${first} opened it and hasn't signed yet`, body: "Reminders go out on their own; you can also nudge them now." };
    case "signed":
      return s.admin
        ? { tone: "warn", title: "Your countersignature is needed", body: `${first} has signed. ${s.autoCountersign ? "Automatic countersigning didn't finish, so apply it now." : "Automatic countersigning is off in Settings, so an admin applies it here."}` }
        : { tone: "warn", title: "Waiting for an admin to countersign", body: `${first} has signed. Only workspace admins can countersign.` };
    case "completed":
      if (!s.ready) return { tone: "error", title: "Not ready for work", body: s.readinessProblem ?? "A required check failed. See the checklist below." };
      if (s.copyFailed) return { tone: "warn", title: "Ready for work, but the client's copy wasn't emailed", body: `${first} can still download it from their link. Send the signed copy again, or share the PDF yourself.` };
      if (!s.copyEmailed && s.outbox) return { tone: "ok", title: "Ready for work", body: "Both parties signed and the PDF is sealed. Email delivery isn't configured here, so the client's copy is available from their link." };
      return { tone: "ok", title: "Ready for work", body: `Both parties signed, the PDF is sealed and ${first} has their copy.` };
    case "declined":
      return { tone: "error", title: `${first} declined to sign`, body: `${f.decline_reason ? `Their reason: “${f.decline_reason}”. ` : ""}If it was a misunderstanding, send it again. If the agreement needs changing, publish a new version and open a new file.` };
    case "expired":
      return { tone: "warn", title: "The signing link expired", body: `${first} didn't sign in time. Reopening sends a fresh email and restarts the expiry clock.` };
    case "voided":
      return { tone: "neutral", title: "This file was voided", body: "The signing link no longer works and nothing more can happen on this file." };
  }
}
