import { NextResponse } from "next/server";
import { handle, rateLimit, readForm, sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/files";
import { ingestAgreement } from "@/lib/templates";
import { MAX_UPLOAD } from "@/lib/convert";

export const runtime = "nodejs";

export const POST = handle(async (req: Request) => {
  const { s, ws } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can upload agreements.", 403);
  rateLimit(req, "upload", 20);
  const form = await readForm(req, MAX_UPLOAD + 64 * 1024);
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("Choose a file to upload.");
  if (file.size > MAX_UPLOAD) throw new AppError("Files up to 20 MB are supported.", 413);
  if (file.size === 0) throw new AppError("That file is empty.");
  const name = (form.get("name") as string | null)?.trim() || undefined;
  const templateId = (form.get("templateId") as string | null) || undefined;
  const { template, version } = await ingestAgreement(ws, { data: Buffer.from(await file.arrayBuffer()), filename: file.name || "agreement.pdf" }, { name, templateId, actor: s.userEmail });
  return NextResponse.json({ templateId: template.id, versionId: version.id });
});
