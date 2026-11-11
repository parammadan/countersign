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
export function phoneLimit(req: Request | Headers, tok: string) {
  const t = typeof tok === "string" ? sha256(tok).slice(0, 32) : "none";
  const h = req instanceof Headers ? req : req.headers;
  if (limited(`scanphone:t:${t}`, 150, 10 * 60_000) || limited(`scanphone:ip:${clientIp(h)}`, 400, 10 * 60_000))
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

/** How long a page upload's body may take to arrive (then 408, and its upload slot is freed). */
export const PAGE_READ_MS = { value: 30_000 };

/**
 * Read a body of at most `max` bytes, all of it within `deadlineMs` (a slow trickle can't hold an upload slot for
 * minutes). Like lib/http.ts readCapped, plus the deadline.
 */
export async function readBodyWithin(req: Request, max: number, deadlineMs: number): Promise<Buffer> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((res) => (timer = setTimeout(() => res("late"), deadlineMs)));
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), late]);
      if (r === "late") {
        await reader.cancel().catch(() => {});
        throw new AppError("The page took too long to arrive. Try again.", 408);
      }
      if (r.done) break;
      total += r.value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new AppError("Request too large.", 413);
      }
      chunks.push(r.value);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}
