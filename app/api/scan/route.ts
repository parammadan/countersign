import { sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { clientIp, limited } from "@/lib/ratelimit";
import { appUrl } from "@/lib/paths";
import { qrDataUrl } from "@/lib/qr";
import { createScan } from "@/lib/scan";
import { scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Scan with phone", desktop side: start a 10-minute scan session for the signed-in admin (the same permission as
// uploading an agreement) and return its phone link and QR code. The raw token exists only in this answer.
export const POST = scanHandle(async (req: Request) => {
  const { s } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can upload agreements.", 403);
  if (limited(`scancreate:u:${s.userId}`, 10, 10 * 60_000) || limited(`scancreate:ip:${clientIp(req.headers)}`, 30, 10 * 60_000))
    throw new AppError("Too many scans started. Wait a few minutes and try again.", 429);
  const scan = await createScan({ workspaceId: s.workspaceId, userId: s.userId });
  const url = `${appUrl()}/scan/${scan.token}`;
  return scanJson({ id: scan.id, url, qr: await qrDataUrl(url), expiresAt: scan.expiresAt });
});
