import { apiAuth, handle } from "@/lib/http";
import { AppError, downloadName, getFile } from "@/lib/files";
import { one } from "@/lib/db";
import { getBlob } from "@/lib/storage";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws } = apiAuth(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'final'", f.id);
  if (!doc) throw new AppError("Not completed yet.", 409);
  const buf = await getBlob(doc.path);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${downloadName(f)}"`, "X-Content-SHA256": doc.sha256 },
  });
});
