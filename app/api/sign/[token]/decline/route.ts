import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit, readJson } from "@/lib/http";
import { AppError, declineFile } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "decline", 5);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  await requireSigner(file, ws);
  const { reason } = (await readJson(req)) as { reason?: string };
  if (!reason || reason.trim().length < 3) throw new AppError("Tell the sender briefly why you're declining.");
  await declineFile(token, reason.trim(), ctxOf(req));
  return NextResponse.json({ ok: true });
});
