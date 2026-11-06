import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit } from "@/lib/http";
import { AppError, sendOtp } from "@/lib/files";
import { signerOr404 } from "@/lib/signer";
import { limited } from "@/lib/ratelimit";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "otp", 5);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  if (!["sent", "viewed", "completed"].includes(file.status)) throw new AppError("This agreement isn't available.", 409);
  if (limited(`otp-file:${file.id}`, 5, 3600_000)) throw new AppError("Too many codes requested. Try again in an hour.", 429);
  const sent = await sendOtp(file, ws, ctxOf(req));
  if (!sent) throw new AppError("We couldn't send the code email just now. Try again in a minute, or contact the sender.", 502);
  const [user, domain] = file.client_email.split("@");
  return NextResponse.json({ ok: true, to: `${user.slice(0, 2)}***@${domain}` });
});
