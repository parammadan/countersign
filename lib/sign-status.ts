import { copyLinkClosed } from "./files";
import type { FileRow } from "./types";
import { now } from "./util";

/** What the signing link's status route tells a browser: where the agreement is, and nothing else. */
export const SIGN_STATUSES = ["pending", "signed", "completed", "declined", "voided", "expired"] as const;
export type SignStatus = (typeof SIGN_STATUSES)[number];

/**
 * The public status of a signing link, by the same rules as the signing page (app/s/[token]/page.tsx): a link past
 * its expiry date is expired, and so is a completed one more than 30 days after completion. It only reads: unlike the
 * page it doesn't move a due file to `expired` (the page, the PDF route and the worker do that), so polling it writes
 * nothing, no audit event and no "viewed".
 */
export function publicSignStatus(f: FileRow, at = now()): SignStatus {
  switch (f.status) {
    case "draft":
      return "pending";
    case "sent":
    case "viewed":
      return f.expires_at && f.expires_at < at ? "expired" : "pending";
    case "signed":
      return "signed";
    case "completed":
      return copyLinkClosed(f) ? "expired" : "completed";
    case "declined":
      return "declined";
    case "voided":
      return "voided";
    case "expired":
      return "expired";
  }
}
