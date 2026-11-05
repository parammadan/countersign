import { NextResponse } from "next/server";
import { apiAuth, handle } from "@/lib/http";
import { fileJson, getFile } from "@/lib/files";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws } = apiAuth(req);
  const { id } = await ctx.params;
  return NextResponse.json(fileJson(getFile(ws.id, id)));
});
