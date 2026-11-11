// Per-workspace rolling-24h cap on client-facing invitation emails. CSV import, create-and-send, the API and the
// inbound webhook all reach the client through createFile/sendFile, which call assertInviteCap, so the cap is
// enforced in one place on the server. Counted from the existing `emails` table (no schema change).
//
// Counted: kind 'invite' and 'resend' (a new send to a client), whatever the delivery status, since a failed
// attempt may still have reached the provider. Exempt: 'reminder'. Reminders only go to a file that was already
// invited, are bounded per file by the reminder schedule (reminders_sent), and are sent by the worker, so
// blocking them at the cap would silently stall in-flight files. Signing codes (OTP) and other system mail are
// different kinds and are never counted.
//
// Limits (env, parsed defensively: unset, blank, non-numeric, fractional or <= 0 fall back to the default):
//   INVITE_CAP_PER_DAY             confirmed workspaces, default 200
//   INVITE_CAP_UNCONFIRMED_PER_DAY unconfirmed workspaces, default 20
// Note the check and the insert are not one transaction: concurrent requests can overshoot by the number in flight.
import { one } from "./db";
import { verificationRequired, workspaceVerified } from "./emailverify";
import { AppError } from "./errors";

export const DEFAULT_INVITE_CAP = 200;
export const DEFAULT_INVITE_CAP_UNCONFIRMED = 20;

export function parseCap(raw: string | undefined, fallback: number): number {
  const s = (raw ?? "").trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The invitations per rolling 24 hours this workspace may send. With no email provider nothing leaves the server, so the confirmed limit applies. */
export function inviteCap(wsId: string): number {
  const confirmed = !verificationRequired() || workspaceVerified(wsId);
  return confirmed ? parseCap(process.env.INVITE_CAP_PER_DAY, DEFAULT_INVITE_CAP) : parseCap(process.env.INVITE_CAP_UNCONFIRMED_PER_DAY, DEFAULT_INVITE_CAP_UNCONFIRMED);
}

export function invitesLast24h(wsId: string): number {
  return one<{ n: number }>("SELECT COUNT(*) n FROM emails WHERE workspace_id = ? AND kind IN ('invite','resend') AND created_at > ?", wsId, new Date(Date.now() - 86400_000).toISOString())?.n ?? 0;
}

export function assertInviteCap(wsId: string) {
  const cap = inviteCap(wsId);
  if (invitesLast24h(wsId) >= cap) throw new AppError(`This workspace has sent ${cap} invitations in the last 24 hours, the current limit. Try again later.`, 429);
}
