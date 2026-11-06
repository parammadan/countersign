import { NextResponse } from "next/server";
import { apiAuth, handle } from "@/lib/http";
import { fileJson, getFile, readiness } from "@/lib/files";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws } = apiAuth(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  const r = await readiness(f);
  // the single-file read re-checks every condition, including the sealed PDF's fingerprint
  return NextResponse.json({ ...fileJson(f), ready_for_work: r.ready, readiness: r.checks });
});
