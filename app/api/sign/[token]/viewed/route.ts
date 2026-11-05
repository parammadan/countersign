import { NextResponse } from "next/server";
import { ctxOf, handle, rateLimit } from "@/lib/http";
import { markViewed } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";

// Recorded from the browser once the page is actually shown, so link scanners that only GET the
// page don't create a false "client opened it" event.
export const POST = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "viewed", 30);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  await requireSigner(file, ws);
  markViewed(file, ws, ctxOf(req));
  return NextResponse.json({ ok: true });
});
