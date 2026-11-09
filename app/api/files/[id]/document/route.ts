import { ctxOf, handle, sessionOr401 } from "@/lib/http";
import { AppError, downloadName, getFile, verifiedBlob } from "@/lib/files";
import { one } from "@/lib/db";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { s, ws } = await sessionOr401(req);
  const { id } = await ctx.params;
  const f = getFile(ws.id, id);
  const kind = new URL(req.url).searchParams.get("kind") === "client_signed" ? "client_signed" : "final";
  const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = ?", f.id, kind);
  if (!doc) throw new AppError("No signed document yet.", 404);
  const buf = await verifiedBlob(doc.path, doc.sha256, { wsId: ws.id, fileId: f.id, document: kind, actor: s.userEmail, ctx: ctxOf(req) });
  const name = kind === "final" ? downloadName(f) : downloadName(f).replace(" - signed", " - client signed");
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
  });
});
