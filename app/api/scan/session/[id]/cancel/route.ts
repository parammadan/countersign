import { sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { limited } from "@/lib/ratelimit";
import { cancelScan } from "@/lib/scan";
import { scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The desktop cancels its scan: the phone link stops working at once and any pages already sent are deleted.
export const POST = scanHandle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { s } = await sessionOr401(req);
  // per signed-in user (after the cookie check), so people sharing an office address don't use up each other's limit
  if (limited(`scancancel:${s.userId}`, 30, 60_000)) throw new AppError("Too many requests.", 429);
  const { id } = await ctx.params;
  const st = await cancelScan({ workspaceId: s.workspaceId, userId: s.userId }, id);
  if (!st) throw new AppError("Not found.", 404);
  return scanJson(st);
});
