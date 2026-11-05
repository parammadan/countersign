import { handle, sessionOr401 } from "@/lib/http";
import { AppError, downloadName, getFile } from "@/lib/files";
import { one } from "@/lib/db";
import { getBlob } from "@/lib/storage";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws } = await sessionOr401(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  const kind = new URL(req.url).searchParams.get("kind") === "client_signed" ? "client_signed" : "final";
  const doc = one<{ path: string }>("SELECT path FROM documents WHERE file_id = ? AND kind = ?", f.id, kind);
  if (!doc) throw new AppError("No signed document yet.", 404);
  const buf = await getBlob(doc.path);
  const name = kind === "final" ? downloadName(f) : downloadName(f).replace(" - signed", " - client signed");
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
  });
});
