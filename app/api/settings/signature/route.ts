import { NextResponse } from "next/server";
import { handle, readJson, sessionOr401 } from "@/lib/http";
import { AppError } from "@/lib/files";
import { putBlob } from "@/lib/storage";
import { run } from "@/lib/db";
import { audit } from "@/lib/audit";

export const POST = handle(async (req: Request) => {
  const { s, ws } = await sessionOr401(req);
  if (s.role === "staff") throw new AppError("Only admins can change the countersignature.", 403);
  const body = (await readJson(req)) as { signature?: string; name?: string; title?: string; email?: string };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body.signature ?? "");
  if (!m) throw new AppError("Draw or type a signature first.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 600_000 || buf.length < 24 || buf.subarray(1, 4).toString("latin1") !== "PNG") throw new AppError("Invalid signature image.");
  if (buf.readUInt32BE(16) > 4000 || buf.readUInt32BE(20) > 2000) throw new AppError("Signature image is too large.");
  const name = (body.name ?? "").trim().slice(0, 120);
  const email = (body.email ?? "").trim().toLowerCase().slice(0, 320);
  if (!name) throw new AppError("Enter the countersigner's name.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("Enter a valid email.");
  const p = await putBlob(`ws/${ws.id}/countersign-${Date.now()}.png`, buf);
  run(
    "UPDATE workspaces SET countersign_image = ?, countersigner_name = ?, countersigner_title = ?, countersigner_email = COALESCE(NULLIF(?, ''), countersigner_email) WHERE id = ?",
    p, name, (body.title ?? "").trim().slice(0, 120) || null, email, ws.id,
  );
  audit(ws.id, null, "workspace.countersignature_adopted", s.userEmail, {}, { name });
  return NextResponse.json({ ok: true });
});
