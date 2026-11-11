import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run, tx } from "./db";
import { AppError, getWorkspace } from "./files";
import { dataDir } from "./paths";
import { putBlob, getBlob } from "./storage";
import { ingestAgreement } from "./templates";
import { MAX_UPLOAD } from "./convert";
import { id, sha256, token as randomToken } from "./util";

// "Scan with phone": an admin on a desktop opens a short-lived scan session and shows its link as a QR code. Their
// phone opens /scan/<token> (no login: the token is the only credential), photographs the pages and sends them here.
// The server checks each one is a real JPEG or PNG, stores it under the session's own folder, and on "Send" makes a
// multipage PDF with pdf-lib and passes it through the same ingestAgreement path as a normal upload: the result is a
// DRAFT agreement for the desktop user, never published or sent. The phone can only add, replace or delete this
// session's pages and finish it; it can read nothing else. Nothing here logs the token or any page content.
//
// The tables are created here with IF NOT EXISTS (not lib/db.ts migrations): they hold only short-lived state.

export const SCAN_TTL_MS = 10 * 60_000;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** Well under the 100-page agreement limit (lib/convert.ts), leaving room for an added signature page. */
export const MAX_PAGES = 30;
/** All pages together: the PDF they make stays within the normal upload limit. */
export const MAX_TOTAL_BYTES = MAX_UPLOAD;
/** The phone sends at most 2200 px; anything far bigger than that wasn't made by our page. */
export const MAX_SIDE = 4096;
/** The long edge of each PDF page in points (11 in): a page keeps its photo's proportions at a familiar size. */
export const PAGE_LONG_EDGE_PT = 792;
/** A build that never finished (the server restarted mid-way) is given up after this long. */
const BUILD_STUCK_MS = 5 * 60_000;
/** Finished sessions are kept a day (so a late status check still gets its answer), then removed. */
const KEEP_MS = 24 * 3600_000;

export type ScanStatus = "waiting" | "connected" | "building" | "done" | "failed" | "cancelled" | "expired";
const OPEN: ScanStatus[] = ["waiting", "connected"];

export type ScanRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  token_hash: string;
  status: ScanStatus;
  page_count: number;
  created_at: string;
  expires_at: string;
  connected_at: string | null;
  building_at: string | null;
  result_version_id: string | null;
  error: string | null;
};
type PageRow = { session_id: string; idx: number; kind: "jpeg" | "png"; bytes: number; width: number; height: number; path: string };

const ready = new WeakSet<DatabaseSync>();
function schema() {
  const d = db();
  if (ready.has(d)) return;
  d.exec(`
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      connected_at TEXT,
      building_at TEXT,
      result_version_id TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS scan_sessions_status ON scan_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS scan_sessions_user ON scan_sessions(workspace_id, user_id, status);
    CREATE TABLE IF NOT EXISTS scan_pages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      kind TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, idx)
    );
  `);
  ready.add(d);
}

/** The 410 every phone request gets once its session is no longer open (finished, cancelled, expired or failed). */
export class ScanGone extends AppError {
  constructor(public readonly reason: ScanStatus) {
    super(reason === "expired" ? "This scan link has expired. Start again on your computer." : "This scan has ended. Start again on your computer if you need to.", 410);
  }
}

const tokenHash = (t: string) => sha256(`scan:${t}`);
const iso = (ms: number) => new Date(ms).toISOString();

// ---- temporary page files: ws/<workspace>/scan/<session>/..., removed with the session's folder ----

const pageDir = (wsId: string, sid: string) => `ws/${wsId}/scan/${sid}`;
async function removeDir(wsId: string, sid: string) {
  const root = path.resolve(dataDir(), "blobs");
  const p = path.resolve(root, pageDir(wsId, sid));
  if (!p.startsWith(root + path.sep) || !/^[A-Za-z0-9_-]+$/.test(sid) || !/^[A-Za-z0-9_-]+$/.test(wsId)) return;
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}
async function removeFile(rel: string) {
  const root = path.resolve(dataDir(), "blobs");
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) return;
  await fs.rm(p, { force: true }).catch(() => {});
}

/** Drop a session's stored pages (rows and files). */
async function dropPages(s: Pick<ScanRow, "id" | "workspace_id">) {
  run("DELETE FROM scan_pages WHERE session_id = ?", s.id);
  await removeDir(s.workspace_id, s.id);
}

/**
 * Housekeeping, run on every create, status check and phone request (no background worker needed): open sessions
 * past their expiry become expired, a build that never finished becomes failed, every closed session's pages are
 * deleted, and closed sessions older than a day are removed.
 */
export async function sweep(at = Date.now()) {
  schema();
  run(`UPDATE scan_sessions SET status = 'expired' WHERE status IN ('waiting','connected') AND expires_at < ?`, iso(at));
  run(`UPDATE scan_sessions SET status = 'failed', error = ? WHERE status = 'building' AND building_at < ?`, "Making the PDF didn't finish. Start again.", iso(at - BUILD_STUCK_MS));
  const closed = all<Pick<ScanRow, "id" | "workspace_id">>(
    `SELECT DISTINCT s.id, s.workspace_id FROM scan_sessions s JOIN scan_pages p ON p.session_id = s.id WHERE s.status NOT IN ('waiting','connected','building')`,
  );
  for (const s of closed) await dropPages(s);
  const old = all<Pick<ScanRow, "id" | "workspace_id">>(`SELECT id, workspace_id FROM scan_sessions WHERE status NOT IN ('waiting','connected','building') AND created_at < ?`, iso(at - KEEP_MS));
  for (const s of old) {
    await dropPages(s);
    run("DELETE FROM scan_sessions WHERE id = ?", s.id);
  }
}

// ---- the desktop side (cookie session: the routes check the user is an admin) ----

export type Owner = { workspaceId: string; userId: string };

/** Start a scan for this user. Any scan they still had open is cancelled: one at a time. The raw token is returned
 *  once, for the QR code, and only its hash is stored. */
export async function createScan(o: Owner, at = Date.now()): Promise<{ id: string; token: string; expiresAt: string }> {
  await sweep(at);
  const prior = all<ScanRow>(`SELECT * FROM scan_sessions WHERE workspace_id = ? AND user_id = ? AND status IN ('waiting','connected')`, o.workspaceId, o.userId);
  for (const p of prior) {
    run(`UPDATE scan_sessions SET status = 'cancelled' WHERE id = ? AND status IN ('waiting','connected')`, p.id);
    await dropPages(p);
  }
  const sid = id("scan_");
  const tok = randomToken(32);
  const expiresAt = iso(at + SCAN_TTL_MS);
  run(
    `INSERT INTO scan_sessions (id, workspace_id, user_id, token_hash, status, page_count, created_at, expires_at) VALUES (?,?,?,?, 'waiting', 0, ?, ?)`,
    sid,
    o.workspaceId,
    o.userId,
    tokenHash(tok),
    iso(at),
    expiresAt,
  );
  return { id: sid, token: tok, expiresAt };
}

/** A session, only for the user and workspace that started it. */
function ownSession(o: Owner, sid: string): ScanRow | undefined {
  schema();
  if (typeof sid !== "string" || sid.length > 64) return undefined;
  return one<ScanRow>("SELECT * FROM scan_sessions WHERE id = ? AND workspace_id = ? AND user_id = ?", sid, o.workspaceId, o.userId);
}

export type DesktopStatus = { status: ScanStatus; pages: number; expiresAt: string; versionId?: string; error?: string };

/** What the desktop dialog shows. null: not this user's session (the route answers 404). */
export async function scanStatus(o: Owner, sid: string, at = Date.now()): Promise<DesktopStatus | null> {
  await sweep(at);
  const s = ownSession(o, sid);
  if (!s) return null;
  return {
    status: s.status,
    pages: s.page_count,
    expiresAt: s.expires_at,
    ...(s.status === "done" && s.result_version_id ? { versionId: s.result_version_id } : {}),
    ...(s.status === "failed" && s.error ? { error: s.error } : {}),
  };
}

/** Cancel an open session (its link stops working at once). null: not this user's session. */
export async function cancelScan(o: Owner, sid: string): Promise<DesktopStatus | null> {
  const s = ownSession(o, sid);
  if (!s) return null;
  run(`UPDATE scan_sessions SET status = 'cancelled' WHERE id = ? AND status IN ('waiting','connected')`, s.id);
  await dropPages(s);
  return scanStatus(o, sid);
}

// ---- the phone side (the token is the only credential) ----

/** The open session this token belongs to. Unknown token: 404. Closed or past its time: 410. */
async function openByToken(tok: string, at = Date.now()): Promise<ScanRow> {
  await sweep(at);
  if (typeof tok !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(tok)) throw new AppError("Not found.", 404);
  const s = one<ScanRow>("SELECT * FROM scan_sessions WHERE token_hash = ?", tokenHash(tok));
  if (!s) throw new AppError("Not found.", 404);
  if (!OPEN.includes(s.status)) throw new ScanGone(s.status);
  return s;
}

/** For the phone page: is this link usable, and until when? Reads only. */
export async function phoneView(tok: string, at = Date.now()): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: "invalid" | ScanStatus }> {
  try {
    const s = await openByToken(tok, at);
    return { ok: true, expiresAt: s.expires_at };
  } catch (e) {
    if (e instanceof ScanGone) return { ok: false, reason: e.reason };
    if (e instanceof AppError) return { ok: false, reason: "invalid" };
    throw e;
  }
}

export type PhoneLimits = { expiresAt: string; maxPages: number; maxPageBytes: number; maxTotalBytes: number };

/** The phone opened the link: the desktop can say "phone connected". */
export async function phoneConnect(tok: string, at = Date.now()): Promise<PhoneLimits> {
  const s = await openByToken(tok, at);
  run(`UPDATE scan_sessions SET status = 'connected', connected_at = COALESCE(connected_at, ?) WHERE id = ? AND status IN ('waiting','connected')`, iso(at), s.id);
  return { expiresAt: s.expires_at, maxPages: MAX_PAGES, maxPageBytes: MAX_PAGE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES };
}

export type Inspected = { kind: "jpeg" | "png"; width: number; height: number };

/**
 * Is this really a JPEG or PNG we can put in a PDF? Judged by the bytes, never the name or declared type: the magic
 * number, the size limits, then pdf-lib must embed it. PNG dimensions are checked from the header before decoding,
 * so a small file that would decode to a huge bitmap is refused without decoding it.
 */
export async function inspectImage(data: Uint8Array): Promise<Inspected> {
  if (data.byteLength === 0) throw new AppError("That photo is empty.", 422);
  if (data.byteLength > MAX_PAGE_BYTES) throw new AppError(`Each page can be up to ${MAX_PAGE_BYTES / 1024 / 1024} MB.`, 413);
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const isJpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng = b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) throw new AppError("Only JPEG or PNG photos can be used.", 415);
  const tooBig = (w: number, h: number) => !(w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE);
  if (isPng) {
    if (b.subarray(12, 16).toString("latin1") !== "IHDR") throw new AppError("That photo couldn't be read.", 422);
    if (tooBig(b.readUInt32BE(16), b.readUInt32BE(20))) throw new AppError(`Photos can be up to ${MAX_SIDE} pixels on each side.`, 422);
  }
  let img: { width: number; height: number };
  try {
    const doc = await PDFDocument.create();
    img = isJpeg ? await doc.embedJpg(b) : await doc.embedPng(b);
  } catch {
    throw new AppError("That photo couldn't be read.", 422);
  }
  if (tooBig(img.width, img.height)) throw new AppError(`Photos can be up to ${MAX_SIDE} pixels on each side.`, 422);
  return { kind: isJpeg ? "jpeg" : "png", width: img.width, height: img.height };
}

/** Add or replace page `idx` (0-based) of this session. */
export async function phonePutPage(tok: string, idx: number, data: Uint8Array, at = Date.now()): Promise<{ pages: number }> {
  const s = await openByToken(tok, at);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PAGES) throw new AppError(`Up to ${MAX_PAGES} pages.`, 422);
  const info = await inspectImage(data);
  // a fresh file name for every upload, so a replacement never overwrites a file a finishing build is reading
  const rel = `${pageDir(s.workspace_id, s.id)}/p${idx}-${randomToken(6)}.${info.kind === "jpeg" ? "jpg" : "png"}`;
  await putBlob(rel, data);
  let replaced: string | undefined;
  try {
    const pages = tx(() => {
      const cur = one<ScanRow>("SELECT * FROM scan_sessions WHERE id = ?", s.id);
      if (!cur || !OPEN.includes(cur.status)) throw new ScanGone(cur?.status ?? "cancelled");
      if (cur.expires_at < iso(at)) throw new ScanGone("expired");
      const prev = one<PageRow>("SELECT * FROM scan_pages WHERE session_id = ? AND idx = ?", s.id, idx);
      const agg = one<{ n: number; bytes: number }>("SELECT COUNT(*) n, COALESCE(SUM(bytes),0) bytes FROM scan_pages WHERE session_id = ?", s.id)!;
      if (!prev && agg.n >= MAX_PAGES) throw new AppError(`Up to ${MAX_PAGES} pages.`, 422);
      if (agg.bytes - (prev?.bytes ?? 0) + data.byteLength > MAX_TOTAL_BYTES) throw new AppError(`All pages together can be up to ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`, 413);
      replaced = prev?.path;
      run(
        `INSERT INTO scan_pages (session_id, idx, kind, bytes, width, height, path, created_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, idx) DO UPDATE SET kind = excluded.kind, bytes = excluded.bytes, width = excluded.width, height = excluded.height, path = excluded.path, created_at = excluded.created_at`,
        s.id,
        idx,
        info.kind,
        data.byteLength,
        info.width,
        info.height,
        rel,
        iso(at),
      );
      const n = one<{ n: number }>("SELECT COUNT(*) n FROM scan_pages WHERE session_id = ?", s.id)!.n;
      run(`UPDATE scan_sessions SET page_count = ?, status = 'connected', connected_at = COALESCE(connected_at, ?) WHERE id = ?`, n, iso(at), s.id);
      return n;
    });
    if (replaced) await removeFile(replaced);
    return { pages };
  } catch (e) {
    await removeFile(rel);
    throw e;
  }
}

/** Delete page `idx` of this session (nothing to delete is fine). */
export async function phoneDeletePage(tok: string, idx: number, at = Date.now()): Promise<{ pages: number }> {
  const s = await openByToken(tok, at);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PAGES) throw new AppError(`Up to ${MAX_PAGES} pages.`, 422);
  let gone: string | undefined;
  const pages = tx(() => {
    const cur = one<ScanRow>("SELECT * FROM scan_sessions WHERE id = ?", s.id);
    if (!cur || !OPEN.includes(cur.status)) throw new ScanGone(cur?.status ?? "cancelled");
    gone = one<PageRow>("SELECT * FROM scan_pages WHERE session_id = ? AND idx = ?", s.id, idx)?.path;
    run("DELETE FROM scan_pages WHERE session_id = ? AND idx = ?", s.id, idx);
    const n = one<{ n: number }>("SELECT COUNT(*) n FROM scan_pages WHERE session_id = ?", s.id)!.n;
    run("UPDATE scan_sessions SET page_count = ? WHERE id = ?", n, s.id);
    return n;
  });
  if (gone) await removeFile(gone);
  return { pages };
}

/** One PDF page per image, in order, each page with its image's proportions (long edge PAGE_LONG_EDGE_PT). */
export async function buildScanPdf(images: { kind: "jpeg" | "png"; data: Uint8Array }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.kind === "jpeg" ? await doc.embedJpg(im.data) : await doc.embedPng(im.data);
    const scale = PAGE_LONG_EDGE_PT / Math.max(img.width, img.height);
    const w = Math.round(img.width * scale * 100) / 100;
    const h = Math.round(img.height * scale * 100) / 100;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

let building = 0;

/**
 * "Send to computer": pages 0..count-1 (exactly those, all present) become a PDF, which goes through the normal
 * upload path (ingestAgreement) as a new DRAFT agreement for the user who started the scan. The session closes
 * whatever happens, so the link can't be used again; its pages are deleted.
 */
export async function phoneFinalize(tok: string, count: number, at = Date.now()): Promise<{ status: "done" }> {
  const s0 = await openByToken(tok, at);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PAGES) throw new AppError(`Send between 1 and ${MAX_PAGES} pages.`, 422);
  if (building >= 2) throw new AppError("Lots of scans are being made right now. Try again in a few seconds.", 503);
  // check before closing the session, so a phone that's missing a page can upload it and try again
  const have = all<PageRow>("SELECT * FROM scan_pages WHERE session_id = ? ORDER BY idx", s0.id);
  const wanted = have.filter((p) => p.idx < count);
  if (wanted.length !== count || wanted.some((p, i) => p.idx !== i)) throw new AppError("Some pages didn't arrive. Send again.", 409);

  // claim it: only one finish can win, and the link stops working for anything else from here on
  const claimed = run(`UPDATE scan_sessions SET status = 'building', building_at = ? WHERE id = ? AND status IN ('waiting','connected') AND expires_at >= ?`, iso(at), s0.id, iso(at));
  if (Number(claimed.changes) !== 1) {
    const cur = one<ScanRow>("SELECT status FROM scan_sessions WHERE id = ?", s0.id);
    throw new ScanGone(cur && cur.status !== "waiting" && cur.status !== "connected" ? cur.status : "expired");
  }
  building++;
  try {
    // pages as they were at the moment of claiming (nothing can change them after it)
    const pages = all<PageRow>("SELECT * FROM scan_pages WHERE session_id = ? AND idx < ? ORDER BY idx", s0.id, count);
    if (pages.length !== count) throw new AppError("Some pages didn't arrive. Start again.", 409);
    // whoever started the scan must still be allowed to upload agreements in that workspace
    const who = one<{ role: string; email: string }>("SELECT m.role, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?", s0.workspace_id, s0.user_id);
    if (!who || who.role === "staff") throw new AppError("The person who started this scan can no longer upload agreements.", 403);
    const images = [];
    for (const p of pages) {
      const data = await getBlob(p.path);
      const info = await inspectImage(data); // stored by us, but checked again: what goes in the PDF is what we validated
      images.push({ kind: info.kind, data });
    }
    const pdf = await buildScanPdf(images);
    if (pdf.length > MAX_UPLOAD) throw new AppError("These pages make a PDF over 20 MB. Send fewer pages.", 413);
    const { version } = await ingestAgreement(getWorkspace(s0.workspace_id), { data: pdf, filename: "Scanned agreement.pdf" }, { actor: who.email });
    run(`UPDATE scan_sessions SET status = 'done', result_version_id = ?, page_count = ? WHERE id = ?`, version.id, count, s0.id);
    return { status: "done" };
  } catch (e) {
    // only our own fixed messages reach the desktop; anything unexpected becomes a generic one
    const msg = e instanceof AppError ? e.message.slice(0, 300) : "Making the PDF failed. Start again.";
    run(`UPDATE scan_sessions SET status = 'failed', error = ? WHERE id = ?`, msg, s0.id);
    throw e instanceof AppError ? e : new AppError("Making the PDF failed. Start again.", 500);
  } finally {
    building--;
    await dropPages(s0);
  }
}

/** Test hook: the stored pages of a session (paths are relative to the blob store). */
export function _pagesOf(sid: string): PageRow[] {
  schema();
  return all<PageRow>("SELECT * FROM scan_pages WHERE session_id = ? ORDER BY idx", sid);
}
export function _session(sid: string): ScanRow | undefined {
  schema();
  return one<ScanRow>("SELECT * FROM scan_sessions WHERE id = ?", sid);
}
