import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit } from "@/lib/http";
import { AppError, sendOtp } from "@/lib/files";
import { signerOr404 } from "@/lib/signer";
import { limited } from "@/lib/ratelimit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "otp", 5);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  if (file.status !== "sent" && file.status !== "viewed") throw new AppError("This agreement isn't waiting for a signature.", 409);
  if (limited(`otp-file:${file.id}`, 5, 3600_000)) throw new AppError("Too many codes requested. Try again in an hour.", 429);
  await sendOtp(file, ws, ctxOf(req));
  const [user, domain] = file.client_email.split("@");
  return NextResponse.json({ ok: true, to: `${user.slice(0, 2)}***@${domain}` });
});
