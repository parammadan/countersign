import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit, readForm, readJson } from "@/lib/http";
import { AppError, createFile, fileJson } from "@/lib/files";
import { NewFileBody } from "@/lib/schemas";
import { workspaceByInboundToken } from "@/lib/inbound";

export const runtime = "nodejs";

// No-code hook: a CRM, n8n or Zapier posts the new file's client here and the agreement goes out.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "inbound", 60);
  const { token } = await ctx.params;
  const ws = workspaceByInboundToken(token);
  if (!ws) throw new AppError("Unknown inbound URL.", 404);
  let body: unknown;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await readForm(req, 200_000);
    body = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
  } else body = await readJson(req);
  const b = NewFileBody.parse(body);
  const f = await createFile(ws, b, { kind: "inbound", label: "inbound webhook" }, ctxOf(req), b.send);
  return NextResponse.json(fileJson(f), { status: 201 });
});
