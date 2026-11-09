import { apiAuth, ctxOf, handle } from "@/lib/http";
import { AppError, downloadName, getFile, verifiedBlob } from "@/lib/files";
import { one } from "@/lib/db";
import { sha256 } from "@/lib/util";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws, keyName } = apiAuth(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'final'", f.id);
  if (!doc) throw new AppError("Not completed yet.", 409);
  const buf = await verifiedBlob(doc.path, doc.sha256, { wsId: ws.id, fileId: f.id, document: "final", actor: `API key "${keyName}"`, ctx: ctxOf(req) });
  return new Response(new Uint8Array(buf), {
    // the fingerprint of the bytes actually served, not only the one on record
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${downloadName(f)}"`, "X-Content-SHA256": sha256(buf) },
  });
});
