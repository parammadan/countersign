import { ctxOf, handle, sessionOr401 } from "@/lib/http";
import { getTemplateVersion } from "@/lib/templates";
import { verifiedBlob } from "@/lib/files";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { s, ws } = await sessionOr401(req);
  const { id } = await ctx.params;
  const { version } = getTemplateVersion(ws.id, id);
  const buf = await verifiedBlob(version.pdf_path, version.sha256, { wsId: ws.id, fileId: null, document: `version ${version.id}`, actor: s.userEmail, ctx: ctxOf(req) });
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600" } });
});
