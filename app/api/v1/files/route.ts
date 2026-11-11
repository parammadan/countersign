import { NextResponse } from "next/server";
import { apiAuth, ctxOf, handle, readJson } from "@/lib/http";
import { AppError, createFile, fileJson } from "@/lib/files";
import { NewFileBody } from "@/lib/schemas";
import { all, one } from "@/lib/db";
import type { FileRow } from "@/lib/types";

export const runtime = "nodejs";

export const POST = handle(async (req: Request) => {
  const { ws, keyName } = apiAuth(req);
  const b = NewFileBody.parse(await readJson(req));
  const f = await createFile(ws, b, { kind: "api", label: `API key "${keyName}"` }, ctxOf(req), b.send);
  return NextResponse.json(fileJson(f), { status: 201 });
});

export const GET = handle(async (req: Request) => {
  const { ws } = apiAuth(req);
  const u = new URL(req.url);
  const status = u.searchParams.get("status");
  const ref = u.searchParams.get("ref");
  // a missing or non-numeric limit means the default (Number("abc") is NaN, which SQLite refuses)
  const asked = Number.parseInt(u.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(asked) ? Math.min(100, Math.max(1, asked)) : 50;
  // cursor paging: pass the last id of the previous page as starting_after (ids from another workspace are refused)
  const after = u.searchParams.get("starting_after");
  let cur: { created_at: string; id: string } | null = null;
  if (after) {
    cur = one<{ created_at: string; id: string }>("SELECT created_at, id FROM files WHERE workspace_id = ? AND id = ?", ws.id, after) ?? null;
    if (!cur) throw new AppError("starting_after: no file with that id in this workspace.", 404);
  }
  const rows = all<FileRow>(
    `SELECT * FROM files WHERE workspace_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR ref = ?)
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
    ws.id, status, status, ref, ref, cur?.created_at ?? null, cur?.created_at ?? null, cur?.created_at ?? null, cur?.id ?? null, limit + 1,
  );
  return NextResponse.json({ data: rows.slice(0, limit).map(fileJson), has_more: rows.length > limit });
});
