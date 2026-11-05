import { NextResponse } from "next/server";
import { apiAuth, ctxOf, handle, readJson } from "@/lib/http";
import { createFile, fileJson } from "@/lib/files";
import { NewFileBody } from "@/lib/schemas";
import { all } from "@/lib/db";
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
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") || 50)));
  const rows = all<FileRow>(
    `SELECT * FROM files WHERE workspace_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR ref = ?) ORDER BY created_at DESC LIMIT ?`,
    ws.id, status, status, ref, ref, limit,
  );
  return NextResponse.json({ data: rows.map(fileJson) });
});
