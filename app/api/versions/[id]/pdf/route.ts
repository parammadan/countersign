import { handle, sessionOr401 } from "@/lib/http";
import { getTemplateVersion } from "@/lib/templates";
import { getBlob } from "@/lib/storage";

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { ws } = await sessionOr401(req);
  const { id } = await ctx.params;
  const { version } = getTemplateVersion(ws.id, id);
  const buf = await getBlob(version.pdf_path);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600" } });
});
