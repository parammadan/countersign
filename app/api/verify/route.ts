import { NextResponse } from "next/server";
import { handle, rateLimit } from "@/lib/http";
import { AppError } from "@/lib/files";
import { one } from "@/lib/db";
import { sha256 } from "@/lib/util";

export const runtime = "nodejs";

export const POST = handle(async (req: Request) => {
  rateLimit(req, "verify", 20);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("Choose a PDF.");
  if (file.size > 30 * 1024 * 1024) throw new AppError("File too large.", 413);
  const hash = sha256(Buffer.from(await file.arrayBuffer()));
  const row = one<{ kind: string; title: string; completed_at: string | null; client_signed_at: string | null; firm: string }>(
    `SELECT d.kind, f.title, f.completed_at, f.client_signed_at, w.legal_name AS firm FROM documents d
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
  });
});
