import { ctxOf, handle, rateLimit } from "@/lib/http";
import { AppError, downloadName } from "@/lib/files";
import { requireSigner, signerOr404 } from "@/lib/signer";
import { one } from "@/lib/db";
import { getBlob } from "@/lib/storage";
import { audit } from "@/lib/audit";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  rateLimit(req, "download", 30);
  const { token } = await ctx.params;
  const { file, ws } = signerOr404(token);
  if (file.status !== "completed") throw new AppError("The signed copy isn't ready yet.", 409);
  await requireSigner(file, ws);
  const doc = one<{ path: string }>("SELECT path FROM documents WHERE file_id = ? AND kind = 'final'", file.id);
  if (!doc) throw new AppError("Signed copy not found.", 404);
  audit(ws.id, file.id, "file.downloaded", file.client_email, ctxOf(req));
  const buf = await getBlob(doc.path);
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName(file)}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
