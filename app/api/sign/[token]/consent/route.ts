import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit } from "@/lib/http";
import { AppError, recordConsent } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";

// Consent is logged the moment the client gives it (not when they finish signing).
export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "consent", 20);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  await requireSigner(file, ws);
  if (file.status !== "sent" && file.status !== "viewed") throw new AppError("This agreement isn't waiting for a signature.", 409);
  recordConsent(file, ws, ctxOf(req));
  return NextResponse.json({ ok: true });
});
