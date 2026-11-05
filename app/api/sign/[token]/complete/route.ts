import { NextResponse } from "next/server";
import { z } from "zod";
import { ctxOf, handle, rateLimit, readJson } from "@/lib/http";
import { completeClientSigning } from "@/lib/files";

export const runtime = "nodejs";

const Body = z.object({
  consent: z.literal(true),
  values: z.record(z.string().max(20), z.union([z.string().max(300), z.boolean()])),
  signature: z.string().max(900_000).optional(),
  initials: z.string().max(900_000).optional(),
  method: z.enum(["drawn", "typed"]),
});

export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "complete", 10);
  const { token } = await ctx.params;
  const body = Body.parse(await readJson(req, 2_500_000));
  const f = await completeClientSigning(token, body, ctxOf(req));
  return NextResponse.json({ ok: true, status: f.status });
});
