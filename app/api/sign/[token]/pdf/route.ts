import { handle, rateLimit } from "@/lib/http";
import { AppError } from "@/lib/files";
import { signerOr404 } from "@/lib/signer";
import { getBlob } from "@/lib/storage";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "signpdf", 60);
  const { token } = await ctx.params;
  const { file, version, ws } = signerOr404(token);
  if (file.status === "voided") throw new AppError("This agreement was withdrawn by the sender.", 410);
  if (ws.require_otp && !file.otp_verified_at && file.status !== "completed") throw new AppError("Verify your email code first.", 403);
  const buf = await getBlob(version.pdf_path);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store" } });
});
