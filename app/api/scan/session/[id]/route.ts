import { sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { clientIp, limited } from "@/lib/ratelimit";
import { scanStatus } from "@/lib/scan";
import { scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Polled by the desktop dialog every 2 s: where the scan is (waiting, phone connected, N pages, building, done with
// the new draft's id, or closed). Only the user who started it, in that workspace, can see it; anyone else gets 404.
export const GET = scanHandle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  if (limited(`scanstatus:${clientIp(req.headers)}`, 120, 60_000)) throw new AppError("Too many requests.", 429);
  const { s } = await sessionOr401(req);
  const { id } = await ctx.params;
  const st = await scanStatus({ workspaceId: s.workspaceId, userId: s.userId }, id);
  if (!st) throw new AppError("Not found.", 404);
  return scanJson(st);
});
