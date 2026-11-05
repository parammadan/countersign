import { handle, sessionOr401 } from "@/lib/http";
import { all } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { STATUS_LABEL, type FileRow } from "@/lib/types";

export const GET = handle(async (req: Request) => {
  const { ws } = await sessionOr401(req);
  const rows = all<FileRow & { agreement: string; version: number }>(
    `SELECT f.*, t.name AS agreement, v.version FROM files f JOIN template_versions v ON v.id = f.template_version_id JOIN templates t ON t.id = v.template_id
     WHERE f.workspace_id = ? ORDER BY f.created_at DESC`,
    ws.id,
  );
  const csv = toCsv([
    ["file_id", "ref", "title", "status", "client_name", "client_email", "client_company", "agreement", "version", "created_at", "sent_at", "viewed_at", "client_signed_at", "completed_at", "declined_at", "decline_reason", "expires_at"],
    ...rows.map((f) => [f.id, f.ref, f.title, STATUS_LABEL[f.status], f.client_name, f.client_email, f.client_company, f.agreement, f.version, f.created_at, f.sent_at, f.viewed_at, f.client_signed_at, f.completed_at, f.declined_at, f.decline_reason, f.expires_at]),
  ]);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="countersign-files-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
