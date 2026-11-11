import { AppError } from "@/lib/errors";
import { clientIp } from "@/lib/ratelimit";
import { sha256 } from "@/lib/util";
import { MAX_PAGE_BYTES, phoneCheck, phoneDeletePage, phonePutPage } from "@/lib/scan";
import { PAGE_READ_MS, phoneLimit, phoneOrigin, readBodyWithin, scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Page n (0-based) of the phone's scan: PUT the image bytes (a JPEG, checked by content, up to 8 MB) to add or
// replace it, DELETE to remove it. Answers only how many pages the scan now has.
//
// Before any body is read: the token must belong to an open scan, the request must declare its length (at most
// 8 MB), and an upload slot must be free: at most 4 uploads are read at once across the server, 1 per scan token and
// 2 per address (others get 503 and the phone retries), so many parallel uploads can't hold more than a few pages in
// memory and one phone can't take every slot. A body must arrive within 30 s (else 408), so a slow trickle can't
// hold a slot either.
const MAX_IN_FLIGHT = 4;
const PER_TOKEN = 1;
const PER_IP = 2;
let inFlight = 0;
const byToken = new Map<string, number>();
const byIp = new Map<string, number>();
const bump = (m: Map<string, number>, k: string, d: number) => {
  const n = (m.get(k) ?? 0) + d;
  if (n > 0) m.set(k, n);
  else m.delete(k);
};
const index = (n: string) => (/^\d{1,2}$/.test(n) ? Number(n) : -1);

export const PUT = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  await phoneCheck(token);
  const len = req.headers.get("content-length");
  if (len === null || !/^\d{1,9}$/.test(len)) throw new AppError("Send the page with its length.", 411);
  if (Number(len) > MAX_PAGE_BYTES) throw new AppError(`Each page can be up to ${MAX_PAGE_BYTES / 1024 / 1024} MB.`, 413);
  const t = sha256(token);
  const a = clientIp(req.headers);
  if (inFlight >= MAX_IN_FLIGHT || (byToken.get(t) ?? 0) >= PER_TOKEN || (byIp.get(a) ?? 0) >= PER_IP) throw new AppError("Busy, retry in a moment.", 503);
  inFlight++;
  bump(byToken, t, 1);
  bump(byIp, a, 1);
  try {
    const body = await readBodyWithin(req, Math.min(Number(len), MAX_PAGE_BYTES), PAGE_READ_MS.value);
    return scanJson(await phonePutPage(token, index(n), body));
  } finally {
    inFlight--;
    bump(byToken, t, -1);
    bump(byIp, a, -1);
  }
});

export const DELETE = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string; n: string }> }) => {
  const { token, n } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  return scanJson(await phoneDeletePage(token, index(n)));
});
