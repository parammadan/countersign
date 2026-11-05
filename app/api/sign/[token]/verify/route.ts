import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit, readJson } from "@/lib/http";
import { AppError, verifyOtp } from "@/lib/files";
import { signerOr404 } from "@/lib/signer";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "otpverify", 10);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  const { code } = (await readJson(req)) as { code?: string };
  if (!code || !/^\d{6}$/.test(code.trim())) throw new AppError("Enter the 6-digit code.");
  if (!verifyOtp(file, ws, code, ctxOf(req))) throw new AppError("That code isn't right. Check the latest email and try again.");
  return NextResponse.json({ ok: true });
});
