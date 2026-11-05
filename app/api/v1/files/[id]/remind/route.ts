import { NextResponse } from "next/server";
import { apiAuth, ctxOf, handle } from "@/lib/http";
import { AppError, fileJson, getFile, sendFile } from "@/lib/files";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws, keyName } = apiAuth(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  if (f.status !== "sent" && f.status !== "viewed") throw new AppError(`Can't remind a ${f.status} file.`, 409);
  const r = await sendFile(f, ws, "reminder", { kind: "api", label: `API key "${keyName}"` }, ctxOf(req));
  return NextResponse.json(fileJson(r));
});
