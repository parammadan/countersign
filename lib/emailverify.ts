// Email verification for new sign-ups. Until a workspace owner confirms their address, the workspace can
// only send agreements to its own members, so a throwaway sign-up can't use the server to email strangers.
// With no email provider configured nothing leaves the server, so there is nothing to gate.
import { one, run } from "./db";
import { emailMode, layout, sendEmail } from "./email";
import { AppError } from "./errors";
import { appUrl } from "./paths";
import { escapeHtml, now, sha256, token } from "./util";
import { BRAND } from "./brand";

const TTL_MS = 3 * 86400_000;

export function verificationRequired() {
  return emailMode() !== "outbox";
}

export function userVerified(userId: string) {
  return !!one<{ v: string | null }>("SELECT email_verified_at v FROM users WHERE id = ?", userId)?.v;
}

export function workspaceVerified(wsId: string) {
  return !!one("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' AND u.email_verified_at IS NOT NULL LIMIT 1", wsId);
}

export function assertCanSendTo(wsId: string, to: string) {
  if (!verificationRequired() || workspaceVerified(wsId)) return;
  const member = one("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? LIMIT 1", wsId, to.toLowerCase());
  if (member) return;
  throw new AppError(
    "Confirm your email address first. Until the workspace owner does, agreements can only be sent to your own team (try Send a test to me). Check your inbox for the confirmation link.",
    403,
  );
}

export async function sendVerification(user: { id: string; email: string; name: string }, wsId: string) {
  const tok = token(24);
  run("INSERT INTO email_verifications (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)", sha256(tok), user.id, new Date(Date.now() + TTL_MS).toISOString(), now());
  const link = `${appUrl()}/confirm-email/${tok}`;
  return sendEmail({
    workspaceId: wsId,
    kind: "verify_email",
    to: user.email,
    subject: "Confirm your email address",
    html: layout({
      brand: BRAND.color,
      firm: BRAND.name,
      heading: "Confirm your email",
      body: `Hi ${escapeHtml(user.name.split(" ")[0] || user.name)},<br><br>Confirm this is your address so your workspace can send agreements to clients. The link works for 3 days.`,
      cta: { href: link, label: "Confirm my email" },
    }),
    logHtml: "<p>Email confirmation link (withheld from the log).</p>",
  });
}

export function confirmEmail(tok: string): { ok: true; userId: string } | { ok: false; reason: string } {
  const row = one<{ user_id: string; expires_at: string; used_at: string | null }>("SELECT user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?", sha256(tok));
  if (!row) return { ok: false, reason: "This confirmation link isn't valid." };
  if (row.used_at) return { ok: true, userId: row.user_id };
  if (row.expires_at < now()) return { ok: false, reason: "This confirmation link has expired. Sign in and send a new one." };
  const t = now();
  run("UPDATE email_verifications SET used_at = ? WHERE token_hash = ?", t, sha256(tok));
  run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", t, row.user_id);
  return { ok: true, userId: row.user_id };
}
