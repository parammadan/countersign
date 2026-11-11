import { readCapped } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { MAX_PAGE_BYTES, phoneCheck, phoneDeletePage, phonePutPage } from "@/lib/scan";
import { phoneLimit, phoneOrigin, scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Page n (0-based) of the phone's scan: PUT the image bytes (a JPEG, checked by content, up to 8 MB) to add or
// replace it, DELETE to remove it. Answers only how many pages the scan now has.
//
// Before any body is read: the token must belong to an open scan, the request must declare its length (at most
// 8 MB), and at most MAX_IN_FLIGHT uploads are read at once across the server (others get 503 and the phone retries),
// so many parallel uploads can't hold more than a few pages in memory.
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const index = (n: string) => (/^\d{1,2}$/.test(n) ? Number(n) : -1);

export const PUT = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  await phoneCheck(token);
  const len = req.headers.get("content-length");
  if (len === null || !/^\d{1,9}$/.test(len)) throw new AppError("Send the page with its length.", 411);
  if (Number(len) > MAX_PAGE_BYTES) throw new AppError(`Each page can be up to ${MAX_PAGE_BYTES / 1024 / 1024} MB.`, 413);
  if (inFlight >= MAX_IN_FLIGHT) throw new AppError("Busy, retry in a moment.", 503);
  inFlight++;
  try {
    const body = await readCapped(req, Math.min(Number(len), MAX_PAGE_BYTES));
    return scanJson(await phonePutPage(token, index(n), body));
  } finally {
    inFlight--;
  }
});

export const DELETE = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  return scanJson(await phoneDeletePage(token, index(n)));
});
