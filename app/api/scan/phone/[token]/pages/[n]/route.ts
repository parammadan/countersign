import { readCapped } from "@/lib/http";
import { MAX_PAGE_BYTES, phoneDeletePage, phonePutPage } from "@/lib/scan";
import { phoneLimit, phoneOrigin, scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Page n (0-based) of the phone's scan: PUT the image bytes (JPEG or PNG, checked by content, up to 8 MB) to add or
// replace it, DELETE to remove it. Answers only how many pages the scan now has.
const index = (n: string) => (/^\d{1,2}$/.test(n) ? Number(n) : -1);

export const PUT = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  const body = await readCapped(req, MAX_PAGE_BYTES);
  return scanJson(await phonePutPage(token, index(n), body));
});

export const DELETE = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  return scanJson(await phoneDeletePage(token, index(n)));
});
