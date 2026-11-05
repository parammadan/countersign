import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { handle, rateLimit, sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/files";
import { ingestAgreement } from "@/lib/templates";

export const runtime = "nodejs";

// "Try it with a sample": loads a neutral demo agreement into the workspace.
export const POST = handle(async (req: Request) => {
  const { s, ws } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can add agreements.", 403);
  rateLimit(req, "upload", 20);
  const data = await fs.readFile(path.join(process.cwd(), "public/samples/sample-client-agreement.pdf"));
  const { version } = await ingestAgreement(ws, { data, filename: "Sample client agreement.pdf" }, { actor: s.userEmail, name: "Sample client agreement" });
  return NextResponse.json({ versionId: version.id });
});
