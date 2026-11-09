import { ctxOf, handle, rateLimit } from "@/lib/http";
import { AppError, verifiedBlob } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "signpdf", 60);
  const { token } = await ctx.params;
  const { file, version, ws } = signerOr404(token);
  // the same policy as the signing page (app/s/[token]/page.tsx): the agreement is shown only while it waits for
  // the client's signature; a completed copy has its own download route
  if (file.status === "voided") throw new AppError("This agreement was withdrawn by the sender.", 410);
  if (file.status === "declined") throw new AppError("This agreement was declined.", 410);
  if (file.status === "expired") throw new AppError("This signing link has expired. Ask the sender for a new one.", 410);
  if (file.status === "draft") throw new AppError("This agreement hasn't been sent yet.", 404);
  if (file.status !== "sent" && file.status !== "viewed") throw new AppError("This agreement has already been signed.", 409);
  await requireSigner(file, ws);
  const buf = await verifiedBlob(version.pdf_path, version.sha256, { wsId: ws.id, fileId: file.id, document: "original", actor: file.client_email, ctx: ctxOf(req) });
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store" } });
});
