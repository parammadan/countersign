import { handle, rateLimit } from "@/lib/http";
import { AppError } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";
import { getBlob } from "@/lib/storage";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "signpdf", 60);
  const { token } = await ctx.params;
  const { file, version, ws } = signerOr404(token);
  if (file.status === "voided") throw new AppError("This agreement was withdrawn by the sender.", 410);
  await requireSigner(file, ws);
  const buf = await getBlob(version.pdf_path);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store" } });
});
