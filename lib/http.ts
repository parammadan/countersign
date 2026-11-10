import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { AppError, getWorkspace, type Ctx } from "./files";
import { getSession, type Session } from "./auth";
import { one, run } from "./db";
import { now, sha256 } from "./util";
import { clientIp, limited } from "./ratelimit";
import { printForPdf, showChars } from "./pdf/printable";
import type { Workspace } from "./types";

export function jsonError(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function handle<A extends unknown[]>(fn: (req: Request, ...a: A) => Promise<Response>) {
  return async (req: Request, ...a: A): Promise<Response> => {
    try {
      return await fn(req, ...a);
    } catch (e) {
      if (e instanceof AppError) return jsonError(e.message, e.status);
      if (e instanceof z.ZodError) return jsonError(e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 422);
      console.error(e);
      return jsonError("Something went wrong on our side. Please try again.", 500);
    }
  };
}

export function ctxOf(req: Request): Ctx {
  return { ip: clientIp(req.headers), ua: req.headers.get("user-agent") ?? undefined };
}

export async function ctxFromHeaders(): Promise<Ctx> {
  const h = await headers();
  return { ip: clientIp(h), ua: h.get("user-agent") ?? undefined };
}

export function rateLimit(req: Request, bucket: string, max: number, windowMs = 60_000) {
  if (limited(`${bucket}:${clientIp(req.headers)}`, max, windowMs)) throw new AppError("Too many requests. Slow down and try again in a minute.", 429);
}

// Same-origin check for cookie-authenticated JSON routes (CSRF).
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new AppError("Cross-site request blocked.", 403);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("Bad origin.", 403);
  }
}

export async function sessionOr401(req: Request): Promise<{ s: Session; ws: Workspace }> {
  sameOrigin(req);
  const s = await getSession();
  if (!s) throw new AppError("Sign in again.", 401);
  return { s, ws: getWorkspace(s.workspaceId) };
}

export function apiAuth(req: Request): { ws: Workspace; keyName: string } {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(cs_[A-Za-z0-9_-]+)$/.exec(h.trim());
  if (!m) throw new AppError("Missing API key. Send Authorization: Bearer cs_live_...", 401);
  rateLimit(req, "api", 120);
  const k = one<{ id: string; workspace_id: string; name: string; revoked_at: string | null }>("SELECT id, workspace_id, name, revoked_at FROM api_keys WHERE key_hash = ?", sha256(m[1]));
  if (!k || k.revoked_at) throw new AppError("Invalid or revoked API key.", 401);
  // the key's name is the actor in each file's history, which the certificate of completion prints
  const bad = printForPdf(k.name).bad;
  if (bad.length) throw new AppError(`This API key's name has a character signed PDFs can't print (${showChars(bad)}). Create a new key with a name in letters from Western European alphabets, and revoke this one.`, 422);
  run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now(), k.id);
  return { ws: getWorkspace(k.workspace_id), keyName: k.name };
}

// Read a body with a hard byte cap, without trusting (or requiring) Content-Length.
export async function readCapped(req: Request, max: number): Promise<Buffer> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > max) throw new AppError("Request too large.", 413);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new AppError("Request too large.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readForm(req: Request, max: number): Promise<FormData> {
  const buf = await readCapped(req, max);
  try {
    return await new Response(new Uint8Array(buf), { headers: { "content-type": req.headers.get("content-type") || "" } }).formData();
  } catch {
    throw new AppError("Couldn't read the upload. Try again.", 400);
  }
}

export async function readJson(req: Request, max = 2_000_000): Promise<unknown> {
  const text = (await readCapped(req, max)).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("Body must be JSON.", 400);
  }
}
