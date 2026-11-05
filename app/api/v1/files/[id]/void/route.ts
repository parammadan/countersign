import { NextResponse } from "next/server";
import { apiAuth, ctxOf, handle, readJson } from "@/lib/http";
import { fileJson, getFile, voidFile } from "@/lib/files";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws, keyName } = apiAuth(req);
  const { id } = await ctx.params;
  const { reason } = (await readJson(req)) as { reason?: string };
  const f = voidFile(getFile(ws.id, id), ws, { kind: "api", label: `API key "${keyName}"` }, reason || "", ctxOf(req));
  return NextResponse.json(fileJson(f));
});
