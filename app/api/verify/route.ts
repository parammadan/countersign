import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { handle, rateLimit } from "@/lib/http";
import { AppError } from "@/lib/files";
import { one } from "@/lib/db";

export const runtime = "nodejs";

const MAX = 30 * 1024 * 1024;

// The browser posts the PDF bytes as the raw body; we hash as it streams, never holding it all.
export const POST = handle(async (req: Request) => {
  rateLimit(req, "verify", 20);
  if (Number(req.headers.get("content-length") || 0) > MAX) throw new AppError("File too large.", 413);
  if (!req.body) throw new AppError("Choose a PDF.");
  const h = crypto.createHash("sha256");
  const reader = req.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX) {
      await reader.cancel().catch(() => {});
      throw new AppError("File too large.", 413);
    }
    h.update(value);
  }
  if (!total) throw new AppError("Choose a PDF.");
  const hash = h.digest("hex");
  const row = one<{ kind: string; title: string; status: string; completed_at: string | null; client_signed_at: string | null; firm: string }>(
    `SELECT d.kind, f.title, f.status, f.completed_at, f.client_signed_at, w.legal_name AS firm FROM documents d
     JOIN files f ON f.id = d.file_id JOIN workspaces w ON w.id = f.workspace_id WHERE d.sha256 = ? LIMIT 1`,
    hash,
  );
  if (!row) return NextResponse.json({ match: false, sha256: hash });
  return NextResponse.json({
    match: true,
    sha256: hash,
    kind: row.kind === "final" ? "Completed agreement (both parties signed)" : "Client-signed copy (before countersignature)",
    title: row.title,
    firm: row.firm,
    completed_at: row.completed_at ?? row.client_signed_at,
    voided: row.status === "voided",
  });
});
