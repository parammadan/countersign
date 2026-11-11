import { readJson } from "@/lib/http";
import { phoneFinalize } from "@/lib/scan";
import { phoneLimit, phoneOrigin, scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Send to computer": pages 0..count-1 become one PDF, uploaded as a new draft agreement for the person who started
// the scan (the same path as a normal upload; never published or sent). The scan closes; its link answers 410 after.
export const POST = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  const body = (await readJson(req, 1024)) as { count?: unknown };
  return scanJson(await phoneFinalize(token, typeof body.count === "number" ? body.count : NaN));
});
