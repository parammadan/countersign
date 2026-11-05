import { NextResponse } from "next/server";
import { handle, sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/files";
import { publishVersion } from "@/lib/templates";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { s, ws } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can publish agreements.", 403);
  const { id } = await ctx.params;
  publishVersion(ws.id, id, s.userEmail);
  return NextResponse.json({ ok: true });
});
