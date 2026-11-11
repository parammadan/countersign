import { sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { clientIp, limited } from "@/lib/ratelimit";
import { cancelScan } from "@/lib/scan";
import { scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The desktop cancels its scan: the phone link stops working at once and any pages already sent are deleted.
export const POST = scanHandle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  if (limited(`scancancel:${clientIp(req.headers)}`, 30, 60_000)) throw new AppError("Too many requests.", 429);
  const { s } = await sessionOr401(req);
  const { id } = await ctx.params;
  const st = await cancelScan({ workspaceId: s.workspaceId, userId: s.userId }, id);
  if (!st) throw new AppError("Not found.", 404);
  return scanJson(st);
});
