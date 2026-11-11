import { phoneConnect } from "@/lib/scan";
import { phoneLimit, phoneOrigin, scanHandle, scanJson } from "@/lib/scan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The phone page opened: mark the scan "phone connected" and answer only its deadline and limits. The token in the
// URL is the only credential (no cookies are read); a closed scan answers 410, an unknown token 404.
export const POST = scanHandle(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params;
  phoneLimit(req, token);
  phoneOrigin(req);
  return scanJson({ ...(await phoneConnect(token)) });
});
