import { NextResponse } from "next/server";
import { AppError } from "./errors";
import { clientIp, limited } from "./ratelimit";
import { sha256 } from "./util";

// Response plumbing for the "Scan with phone" routes (app/api/scan/**). Every answer is no-store and sends no
// referrer. Errors become a short fixed message; nothing is logged, because phone request URLs carry the token and
// bodies are page photos.

export const SCAN_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export const scanJson = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: SCAN_HEADERS });

export function scanHandle<A extends unknown[]>(fn: (req: Request, ...a: A) => Promise<Response>) {
  return async (req: Request, ...a: A): Promise<Response> => {
    try {
      return await fn(req, ...a);
    } catch (e) {
      if (e instanceof AppError) return scanJson({ error: e.message }, e.status);
      return scanJson({ error: "Something went wrong on our side. Please try again." }, 500);
    }
  };
}

/** The phone routes' own limits: per token and per address, apart from every other route's buckets. */
export function phoneLimit(req: Request, tok: string) {
  const t = typeof tok === "string" ? sha256(tok).slice(0, 32) : "none";
  if (limited(`scanphone:t:${t}`, 150, 10 * 60_000) || limited(`scanphone:ip:${clientIp(req.headers)}`, 400, 10 * 60_000))
    throw new AppError("Too many requests. Wait a minute and try again.", 429);
}

/** Phone requests carry no cookie credentials, but a browser that sends an Origin must be on this site. */
export function phoneOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  let ok = false;
  try {
    ok = new URL(origin).host === host;
  } catch {}
  if (!ok) throw new AppError("Cross-site request blocked.", 403);
}
