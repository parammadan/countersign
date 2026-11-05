import { NextResponse } from "next/server";
import { handle, readJson, sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/files";
import { saveFields } from "@/lib/templates";

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { s, ws } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can edit agreements.", 403);
  const { id } = await ctx.params;
  const body = (await readJson(req)) as { fields?: unknown };
  const fields = saveFields(ws.id, id, body.fields);
  return NextResponse.json({ ok: true, count: fields.length });
});
