import { NextResponse } from "next/server";
import { apiAuth, handle } from "@/lib/http";
import { all } from "@/lib/db";
import { customPrefillKeys, type Field } from "@/lib/fields";

export const GET = handle(async (req: Request) => {
  const { ws } = apiAuth(req);
  const rows = all<{ id: string; name: string; is_default: number; version: number | null; fields_json: string | null; published_at: string | null }>(
    `SELECT t.id, t.name, t.is_default, v.version, v.fields_json, v.published_at FROM templates t
     LEFT JOIN template_versions v ON v.id = t.active_version_id WHERE t.workspace_id = ? AND t.archived = 0 ORDER BY t.created_at`,
    ws.id,
  );
  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      default: !!r.is_default,
      published_version: r.version,
      published_at: r.published_at,
      prefill_fields: r.fields_json ? customPrefillKeys(JSON.parse(r.fields_json) as Field[]).map((k) => ({ key: k.key.slice(7), label: k.label })) : [],
    })),
  });
});
