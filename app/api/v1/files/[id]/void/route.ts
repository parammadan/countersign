import { NextResponse } from "next/server";
import { apiAuth, ctxOf, handle, readJson } from "@/lib/http";
import { fileJson, getFile, voidFile } from "@/lib/files";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws, keyName } = apiAuth(req);
  const { id } = await ctx.params;
  // the body is optional: `null`, a non-object or a non-string reason just means no reason
  const body = await readJson(req);
  const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : "";
  const f = voidFile(getFile(ws.id, id), ws, { kind: "api", label: `API key "${keyName}"` }, reason, ctxOf(req));
  return NextResponse.json(fileJson(f));
});
