// Per-user limit on confirmation-link emails, counted from the links already issued (email_verifications), so it
// holds across restarts and IP addresses: at most one a minute and five an hour. The sign-up email counts.
import { one } from "./db";
import { EMAIL_HELP } from "./email-guidance";

export const VERIFY_RESEND = { gapMs: 60_000, perHour: 5 } as const;

/** Why another link can't be sent to this user now, or null when it can. Synchronous: call it right before sendVerification. */
export function verifyResendRefusal(userId: string, at = Date.now()): string | null {
  const since = (ms: number) => new Date(at - ms).toISOString();
  const recent = one<{ n: number }>("SELECT COUNT(*) n FROM email_verifications WHERE user_id = ? AND created_at > ?", userId, since(VERIFY_RESEND.gapMs))!.n;
  if (recent > 0) return EMAIL_HELP.tooSoon;
  const hour = one<{ n: number }>("SELECT COUNT(*) n FROM email_verifications WHERE user_id = ? AND created_at > ?", userId, since(3600_000))!.n;
  if (hour >= VERIFY_RESEND.perHour) return EMAIL_HELP.tooMany;
  return null;
}
