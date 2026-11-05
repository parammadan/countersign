import { one } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  one("SELECT 1");
  return Response.json({ ok: true });
}
