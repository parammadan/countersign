import { NextResponse } from "next/server";
import { loadByToken } from "@/lib/files";
import { clientIp, limited } from "@/lib/ratelimit";
import { publicSignStatus } from "@/lib/sign-status";
import { signerVerified } from "@/lib/signer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Polled by the signing room on a desktop while the client signs on their phone ("Sign on your phone"). It answers
// only `{ status }` (lib/sign-status.ts): no document content, names or emails, and it writes nothing (no audit
// event, no "viewed", no expiry update). Its own per-IP bucket, so polling never uses up the signing routes' limits.
// Nothing here logs: the request URL carries the signing token.
const headers = { "Cache-Control": "no-store" };
const reply = (body: Record<string, string>, status = 200) => NextResponse.json(body, { status, headers });

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (limited(`signstatus:${clientIp(req.headers)}`, 60, 60_000)) return reply({ error: "Too many requests." }, 429);
  try {
    const { token } = await ctx.params;
    const l = loadByToken(token);
    if (!l) return reply({ error: "Not found." }, 404);
    const status = publicSignStatus(l.file);
    // where the page asks an unverified link holder to confirm who they are before showing a completed agreement,
    // this doesn't say "completed" either (reading the verification cookie writes nothing)
    if (status === "completed" && !(await signerVerified(l.file, l.ws))) return reply({ status: "signed" });
    return reply({ status });
  } catch {
    return reply({ error: "Something went wrong." }, 500);
  }
}
