// "Scan with phone": a short-lived session whose token (only in the QR link) lets a phone add, replace and delete
// page photos and finish the scan, which builds a multipage PDF and passes it through the normal upload path
// (ingestAgreement) as a draft for the desktop user. Covered here: the token and its hash, expiry, single use, cancel,
// owner-only desktop routes, what the phone routes answer, content validation (JPEG only), what is checked before a
// page body is read, page order in the PDF, the draft it makes, cleanup, the throttled sweep, rate limits, and that
// nothing logs the token.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-scan-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "1";

type Sess = { userId: string; userName: string; userEmail: string; workspaceId: string; role: "owner" | "admin" | "staff" };
let current: Sess | null = null;
let reqHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => reqHeaders, cookies: async () => ({ get: () => undefined }) }));
vi.mock("../lib/auth", async (orig) => ({ ...(await orig<typeof import("../lib/auth")>()), getSession: async () => current }));
const ingestCalls: { filename: string; opts: unknown; bytes: number }[] = [];
/** runs inside ingestAgreement, before the real one (to act while a PDF is being built) */
let duringIngest: (() => Promise<void>) | null = null;
vi.mock("../lib/templates", async (orig) => {
  const m = await orig<typeof import("../lib/templates")>();
  return {
    ...m,
    ingestAgreement: async (...a: Parameters<typeof m.ingestAgreement>) => {
      ingestCalls.push({ filename: a[1].filename, opts: a[2], bytes: a[1].data.length });
      await duringIngest?.();
      return m.ingestAgreement(...a);
    },
  };
});

// ---- synthetic images ----
const JPG = ["page-a", "page-b", "page-c"].map((n) => fs.readFileSync(`fixtures/scan/${n}.jpg`));
const JPG_DIMS = [
  [240, 320],
  [320, 200],
  [180, 180],
];
const crcT = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (b: Buffer) => {
  let c = -1;
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (t: string, d: Buffer) => {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, "latin1"), d]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
/** An animated PNG (APNG): acTL, then `frames` fcTL + fdAT pairs over a `side` x `side` canvas, every CRC valid. */
function apng(side: number, frames: number) {
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(side, 0);
  ih.writeUInt32BE(side, 4);
  ih[8] = 8;
  ih[9] = 6;
  const ac = Buffer.alloc(8);
  ac.writeUInt32BE(frames, 0);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("acTL", ac), chunk("IDAT", zlib.deflateSync(Buffer.alloc(5)))];
  for (let i = 0; i < frames; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(2 * i + 1, 0);
    fc.writeUInt32BE(1, 4);
    fc.writeUInt32BE(1, 8);
    const fd = Buffer.alloc(4);
    fd.writeUInt32BE(2 * i + 2, 0);
    parts.push(chunk("fcTL", fc), chunk("fdAT", Buffer.concat([fd, zlib.deflateSync(Buffer.alloc(5))])));
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
/** A real RGB PNG; `claim` writes other dimensions into the header than the pixel data has (a decompression bomb). */
function png(w: number, h: number, claim?: [number, number]) {
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(claim?.[0] ?? w, 0);
  ih.writeUInt32BE(claim?.[1] ?? h, 4);
  ih[8] = 8;
  ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The same JPEG made about `bytes` bigger with comment (COM) segments: still a complete, valid JPEG. */
/** The same JPEG with other dimensions written into its frame header. */
function sof(jpg: Buffer, w: number, h: number) {
  const b = Buffer.from(jpg);
  for (let p = 2; p < b.length; ) {
    const m = b[p + 1];
    if (m === 0xc0 || m === 0xc2) {
      b.writeUInt16BE(h, p + 5);
      b.writeUInt16BE(w, p + 7);
      return b;
    }
    p += 2 + b.readUInt16BE(p + 2);
  }
  throw new Error("no frame header");
}
function padded(jpg: Buffer, bytes: number) {
  const seg = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xff]), Buffer.alloc(0xfffd, 0x20)]);
  return Buffer.concat([jpg.subarray(0, 2), ...Array.from({ length: Math.ceil(bytes / seg.length) }, () => seg), jpg.subarray(2)]);
}

describe("scan with phone", () => {
  let scan: typeof import("../lib/scan");
  let db: typeof import("../lib/db");
  let storage: typeof import("../lib/storage");
  let create: typeof import("../app/api/scan/route");
  let status: typeof import("../app/api/scan/session/[id]/route");
  let cancel: typeof import("../app/api/scan/session/[id]/cancel/route");
  let connect: typeof import("../app/api/scan/phone/[token]/route");
  let pages: typeof import("../app/api/scan/phone/[token]/pages/[n]/route");
  let finish: typeof import("../app/api/scan/phone/[token]/finish/route");
  let ipN = 0;
  const ip = () => `203.0.113.${(++ipN % 250) + 1}`;

  const ADMIN: Sess = { userId: "u_admin", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_a", role: "owner" };
  const OTHER_ADMIN: Sess = { userId: "u_admin2", userName: "Riley Example", userEmail: "riley@example.com", workspaceId: "ws_a", role: "admin" };
  const STAFF: Sess = { userId: "u_staff", userName: "Sam Placeholder", userEmail: "sam@example.com", workspaceId: "ws_a", role: "staff" };
  const LIMIT_ADMIN: Sess = { userId: "u_admin3", userName: "Jordan Sample", userEmail: "jordan@example.com", workspaceId: "ws_a", role: "admin" };
  const OTHER_WS: Sess = { userId: "u_admin", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_b", role: "owner" };

  const req = (url: string, init: RequestInit = {}) => new Request(`http://localhost:3000${url}`, { ...init, headers: { "x-forwarded-for": ip(), ...(init.headers as Record<string, string>) } });
  const tp = (token: string) => ({ params: Promise.resolve({ token }) });
  const np = (token: string, n: number | string) => ({ params: Promise.resolve({ token, n: String(n) }) });
  const ip_ = (id: string) => ({ params: Promise.resolve({ id }) });

  /** Through the route (as the dialog does); the route allows 10 a user per 10 minutes, so most tests use start(). */
  async function startViaRoute(as: Sess = ADMIN) {
    current = as;
    const r = await create.POST(req("/api/scan", { method: "POST" }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { id: string; url: string; qr: string; expiresAt: string };
    return { ...j, token: new URL(j.url).pathname.split("/").pop()! };
  }
  async function start(as: Sess = ADMIN) {
    current = as;
    const c = await scan.createScan({ workspaceId: as.workspaceId, userId: as.userId });
    return { ...c, url: `http://localhost:3000/scan/${c.token}` };
  }
  // as a browser sends it: with its length
  const put = (token: string, n: number | string, body: Uint8Array, type = "image/jpeg") =>
    pages.PUT(req(`/api/scan/phone/${token}/pages/${n}`, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": type, "content-length": String(body.byteLength) } }), np(token, n));
  const del = (token: string, n: number) => pages.DELETE(req(`/api/scan/phone/${token}/pages/${n}`, { method: "DELETE" }), np(token, n));
  const fin = (token: string, count: number) => finish.POST(req(`/api/scan/phone/${token}/finish`, { method: "POST", body: JSON.stringify({ count }), headers: { "content-type": "application/json" } }), tp(token));
  const hello = (token: string) => connect.POST(req(`/api/scan/phone/${token}`, { method: "POST" }), tp(token));
  const stat = async (id: string, as: Sess | null = ADMIN) => {
    current = as;
    return status.GET(req(`/api/scan/session/${id}`), ip_(id));
  };
  const blobDir = (wsId: string, sid: string) => path.join(dir, "blobs", "ws", wsId, "scan", sid);

  beforeAll(async () => {
    db = await import("../lib/db");
    scan = await import("../lib/scan");
    storage = await import("../lib/storage");
    create = await import("../app/api/scan/route");
    status = await import("../app/api/scan/session/[id]/route");
    cancel = await import("../app/api/scan/session/[id]/cancel/route");
    connect = await import("../app/api/scan/phone/[token]/route");
    pages = await import("../app/api/scan/phone/[token]/pages/[n]/route");
    finish = await import("../app/api/scan/phone/[token]/finish/route");
    const t = new Date().toISOString();
    for (const [id, name, legal, inb] of [
      ["ws_a", "Northwind", "Northwind Advisory, LLC", "inb_a"],
      ["ws_b", "Contoso", "Contoso Partners, LLC", "inb_b"],
    ])
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, inbound_token, created_at) VALUES (?,?,?,?,?,?)", id, name, legal, name, inb, t);
    for (const u of [ADMIN, OTHER_ADMIN, STAFF, LIMIT_ADMIN]) db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", u.userId, u.userEmail, u.userName, "x", t);
    for (const u of [ADMIN, OTHER_ADMIN, STAFF, LIMIT_ADMIN, OTHER_WS]) db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", u.workspaceId, u.userId, u.role, t);
  });
  beforeEach(() => {
    ingestCalls.length = 0;
  });

  it("makes a 32-byte random token, keeps only its hash, and puts the raw token only in the phone link", async () => {
    const s = await startViaRoute();
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(s.url).toBe(`http://localhost:3000/scan/${s.token}`);
    expect(s.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    const row = scan._session(s.id)!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(s.token);
    expect(row).toMatchObject({ workspace_id: "ws_a", user_id: "u_admin", status: "waiting", page_count: 0, result_version_id: null });
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(10 * 60_000);
    // two sessions never share a token
    const s2 = await startViaRoute();
    expect(s2.token).not.toBe(s.token);
    // starting a new one cancelled the first: one open scan per person
    expect(scan._session(s.id)!.status).toBe("cancelled");
    expect((await hello(s.token)).status).toBe(410);
  });

  it("follows the scan on the desktop: waiting, phone connected, pages received", async () => {
    const s = await start();
    const st = async () => (await (await stat(s.id)).json()) as Record<string, unknown>;
    expect(await st()).toMatchObject({ status: "waiting", pages: 0, expiresAt: s.expiresAt });
    const h = await hello(s.token);
    expect(h.status).toBe(200);
    expect(await st()).toMatchObject({ status: "connected", pages: 0 });
    expect((await put(s.token, 0, JPG[0])).status).toBe(200);
    expect((await put(s.token, 1, JPG[1])).status).toBe(200);
    expect(await st()).toMatchObject({ status: "connected", pages: 2 });
    expect(Object.keys(await st()).sort()).toEqual(["expiresAt", "pages", "status"]);
  });

  it("the desktop routes answer only the user and workspace that started the scan (404 otherwise); staff can't start one", async () => {
    const s = await start();
    for (const who of [OTHER_ADMIN, OTHER_WS, STAFF]) {
      expect((await stat(s.id, who)).status).toBe(404);
      current = who;
      expect((await cancel.POST(req(`/api/scan/session/${s.id}/cancel`, { method: "POST" }), ip_(s.id))).status).toBe(404);
    }
    expect((await stat(s.id, null)).status).toBe(401);
    expect((await stat("scan_doesnotexist")).status).toBe(404);
    expect(scan._session(s.id)!.status).toBe("waiting"); // none of that cancelled it
    current = STAFF;
    const r = await create.POST(req("/api/scan", { method: "POST" }));
    expect(r.status).toBe(403);
    // cross-site POST from a browser is refused (cookie-authenticated)
    current = ADMIN;
    expect((await create.POST(req("/api/scan", { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    // and the route's own limit: 10 scans a user in 10 minutes
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await create.POST(req("/api/scan", { method: "POST" }))).status);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(10);
    expect(codes.at(-1)).toBe(429);
  });

  it("cancel: the link stops working at once and the pages are deleted", async () => {
    const s = await start();
    await hello(s.token);
    await put(s.token, 0, JPG[0]);
    expect(fs.readdirSync(blobDir("ws_a", s.id))).toHaveLength(1);
    current = ADMIN;
    const r = await cancel.POST(req(`/api/scan/session/${s.id}/cancel`, { method: "POST" }), ip_(s.id));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("cancelled");
    expect(fs.existsSync(blobDir("ws_a", s.id))).toBe(false);
    expect(scan._pagesOf(s.id)).toEqual([]);
    for (const res of [await hello(s.token), await put(s.token, 1, JPG[1]), await del(s.token, 0), await fin(s.token, 1)]) expect(res.status).toBe(410);
  });

  it("expires after 10 minutes: phone requests get 410, the desktop sees expired, the pages are deleted", async () => {
    const s = await start();
    await hello(s.token);
    await put(s.token, 0, JPG[0]);
    const created = new Date(scan._session(s.id)!.created_at).getTime();
    // a second before: still fine
    await expect(scan.phonePutPage(s.token, 1, JPG[1], created + 10 * 60_000 - 1000)).resolves.toEqual({ pages: 2 });
    // just after
    await expect(scan.phoneConnect(s.token, created + 10 * 60_000 + 1)).rejects.toMatchObject({ status: 410 });
    expect(scan._session(s.id)!.status).toBe("expired");
    expect(fs.existsSync(blobDir("ws_a", s.id))).toBe(false);
    expect(scan._pagesOf(s.id)).toEqual([]);
    const st = (await (await stat(s.id)).json()) as { status: string };
    expect(st.status).toBe("expired");
    const g = await fin(s.token, 2);
    expect(g.status).toBe(410);
    expect(((await g.json()) as { error: string }).error).toMatch(/expired/);
    // the phone page's own check says so too
    expect(await scan.phoneView(s.token)).toEqual({ ok: false, reason: "expired" });
    expect(await scan.phoneView("x".repeat(43))).toEqual({ ok: false, reason: "invalid" });
  });

  it("unknown or malformed tokens are 404, and the phone routes don't read the cookie session", async () => {
    for (const t of ["x".repeat(43), "short", "../../etc", "a".repeat(200)]) {
      expect((await hello(t)).status).toBe(404);
      expect((await put(t, 0, JPG[0])).status).toBe(404);
      expect((await fin(t, 1)).status).toBe(404);
    }
    const s = await start();
    current = null; // no one signed in on the phone: it still works with the token alone
    expect((await hello(s.token)).status).toBe(200);
    expect((await put(s.token, 0, JPG[0])).status).toBe(200);
  });

  it("the phone routes answer only their own small facts, can't be read with GET, and send no referrer", async () => {
    for (const m of [connect, pages, finish]) expect(Object.keys(m)).not.toContain("GET");
    const s = await start();
    const h = await hello(s.token);
    expect(h.headers.get("Cache-Control")).toBe("no-store");
    expect(h.headers.get("Referrer-Policy")).toBe("no-referrer");
    const hj = (await h.json()) as Record<string, unknown>;
    expect(Object.keys(hj).sort()).toEqual(["expiresAt", "maxPageBytes", "maxPages", "maxTotalBytes"]);
    const p = await put(s.token, 0, JPG[0]);
    expect(await p.json()).toEqual({ pages: 1 });
    const f = await fin(s.token, 1);
    expect(f.status).toBe(200);
    const fj = await f.json();
    expect(fj).toEqual({ status: "done" }); // no agreement id, name or anything else
    // a cross-site page can't drive the phone routes from a browser either
    const s2 = await start();
    const x = await connect.POST(req(`/api/scan/phone/${s2.token}`, { method: "POST", headers: { origin: "https://evil.example" } }), tp(s2.token));
    expect(x.status).toBe(403);
  });

  it("accepts real JPEGs by their bytes (whatever the declared type), refuses everything else, PNG included", async () => {
    const s = await start();
    expect((await put(s.token, 0, JPG[0])).status).toBe(200);
    expect((await put(s.token, 1, JPG[1], "image/png")).status).toBe(200); // JPEG bytes, declared PNG: the bytes decide
    const bad: [string, Uint8Array, number][] = [
      // the phone page converts every photo to JPEG, so the server takes nothing else: a real PNG, even named .jpg
      ["a real PNG", png(50, 40), 415],
      ["an animated PNG with a 4096 px canvas and 300 frames", apng(4096, 300), 415],
      ["zero bytes", new Uint8Array(0), 422],
      ["a PDF", Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"), 415],
      ["HTML", Buffer.from("<!doctype html><script>alert(1)</script>"), 415],
      ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 415],
      ["JPEG magic, then junk", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]), 422],
      // (these made pdf-lib's PNG decoder loop forever: refused before any decoding)
      ["a truncated PNG", png(30, 30).subarray(0, 60), 415],
      ["a PNG claiming more pixels than its data has", png(8, 8, [100, 100]), 415],
      ["a JPEG with data after its end", Buffer.concat([JPG[0], Buffer.from("<html>")]), 422],
      ["a JPEG cut short", JPG[0].subarray(0, JPG[0].length - 100), 422],
      ["a JPEG frame of 5000 x 10 px", sof(JPG[0], 5000, 10), 422],
      ["a JPEG that says 0 px high", sof(JPG[0], 240, 0), 422],
    ];
    for (const [what, data, code] of bad) {
      const t0 = Date.now();
      const r = await put(s.token, 2, data);
      expect(r.status, what).toBe(code);
      expect(Date.now() - t0, `${what}: refused at once`).toBeLessThan(1000);
      const e = ((await r.json()) as { error: string }).error;
      expect(e, what).not.toMatch(/alert|script|svg/i); // the error never echoes content
    }
    // over 8 MB: refused before reading it all
    const big = Buffer.concat([JPG[0], Buffer.alloc(8 * 1024 * 1024)]);
    expect((await put(s.token, 2, big)).status).toBe(413);
    // nothing bad was stored
    expect(scan._pagesOf(s.id).map((p) => p.idx)).toEqual([0, 1]);
    expect(fs.readdirSync(blobDir("ws_a", s.id))).toHaveLength(2);
    // direct checks of the validator
    await expect(scan.inspectImage(JPG[1])).resolves.toEqual({ kind: "jpeg", width: 320, height: 200 });
    await expect(scan.inspectImage(png(50, 40))).rejects.toMatchObject({ status: 415 });
    // a view into a bigger buffer (as file reads and request bodies often are) is read from its own bytes: pdf-lib's
    // JPEG parser alone would read from the start of the underlying buffer
    const pooled = Buffer.concat([Buffer.from(JPG[0]), Buffer.from(JPG[1])]).subarray(JPG[0].length);
    await expect(scan.inspectImage(pooled)).resolves.toEqual({ kind: "jpeg", width: 320, height: 200 });
  });

  it("refuses more than 30 pages, page numbers out of range, and more than 20 MB in total", async () => {
    const s = await start();
    for (let i = 0; i < 30; i++) expect((await put(s.token, i, JPG[i % 3])).status).toBe(200);
    for (const n of [30, 31, 99, -1, "1e1", "abc", "007"]) expect((await put(s.token, n as number, JPG[0])).status, String(n)).toBe(422);
    // replacing one is still fine at the limit
    expect((await put(s.token, 29, JPG[0])).status).toBe(200);
    expect((await fin(s.token, 31)).status).toBe(422);
    // the most a scan can have still makes an agreement (30 pages + the added signature page, under the 100 limit)
    expect((await fin(s.token, 30)).status).toBe(200);
    const v = db.one<{ pdf_path: string }>("SELECT pdf_path FROM template_versions WHERE id = ?", scan._session(s.id)!.result_version_id!)!;
    expect((await PDFDocument.load(await storage.getBlob(v.pdf_path))).getPageCount()).toBe(31);

    // three pages of ~7.5 MB each (a real JPEG made big with comment segments) make more than 20 MB
    const s2 = await start();
    const heavy = padded(JPG[0], 7.5 * 1024 * 1024);
    await expect(scan.inspectImage(heavy)).resolves.toEqual({ kind: "jpeg", width: 240, height: 320 });
    expect((await put(s2.token, 0, heavy)).status).toBe(200);
    expect((await put(s2.token, 1, heavy)).status).toBe(200);
    const third = await put(s2.token, 2, heavy);
    expect(third.status).toBe(413);
    expect(((await third.json()) as { error: string }).error).toMatch(/20 MB/);
    expect(scan._pagesOf(s2.id)).toHaveLength(2);
  });

  it("finishes into a draft through ingestAgreement, pages in the phone's order, each sized to its photo", async () => {
    const s = await start();
    await hello(s.token);
    // uploaded out of order, one replaced, one deleted: the PDF follows the final page numbers
    expect((await put(s.token, 2, JPG[0])).status).toBe(200);
    expect((await put(s.token, 0, JPG[2])).status).toBe(200);
    expect((await put(s.token, 1, JPG[0])).status).toBe(200);
    expect((await put(s.token, 1, JPG[1])).status).toBe(200); // replaced
    expect((await put(s.token, 3, JPG[1])).status).toBe(200);
    expect(await (await del(s.token, 3)).json()).toEqual({ pages: 3 }); // deleted
    expect(fs.readdirSync(blobDir("ws_a", s.id))).toHaveLength(3); // the replaced file is gone too
    const before = db.one<{ n: number }>("SELECT COUNT(*) n FROM files")!.n;

    const f = await fin(s.token, 3);
    expect(f.status).toBe(200);

    // the normal upload path, once, with a PDF and the desktop user as the actor
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].filename).toBe("Scanned agreement.pdf");
    expect(ingestCalls[0].opts).toEqual({ actor: "avery@example.com" });

    const st = (await (await stat(s.id)).json()) as { status: string; versionId: string; pages: number };
    expect(st).toMatchObject({ status: "done", pages: 3 });
    const v = db.one<{ id: string; template_id: string; status: string; pdf_path: string; source_path: string; workspace_id: string; source_name: string }>("SELECT * FROM template_versions WHERE id = ?", st.versionId)!;
    expect(v).toMatchObject({ status: "draft", workspace_id: "ws_a", source_name: "Scanned agreement.pdf" });
    const t = db.one<{ active_version_id: string | null; name: string }>("SELECT * FROM templates WHERE id = ?", v.template_id)!;
    expect(t.active_version_id).toBeNull(); // never published
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM files")!.n).toBe(before); // nothing sent
    const ev = db.one<{ type: string; actor: string; data_json: string }>("SELECT * FROM audit_events WHERE workspace_id = 'ws_a' AND type = 'template.uploaded' ORDER BY rowid DESC LIMIT 1")!;
    expect(ev.actor).toBe("avery@example.com");
    expect(ev.data_json).not.toContain(s.token);

    // read the PDF back: the scanned pages first, in order, each with its photo's proportions and pixels
    const pdf = await PDFDocument.load(await storage.getBlob(v.pdf_path));
    const want = [JPG_DIMS[2], JPG_DIMS[1], JPG_DIMS[0]];
    const got = pdf.getPages().slice(0, 3).map((p) => {
      const xo = p.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
      const keys = xo.keys();
      expect(keys).toHaveLength(1);
      const im = xo.lookup(keys[0]) as PDFRawStream;
      const n = (k: string) => (im.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
      return { img: [n("Width"), n("Height")], ratio: p.getWidth() / p.getHeight(), long: Math.max(p.getWidth(), p.getHeight()) };
    });
    expect(got.map((g) => g.img)).toEqual(want);
    got.forEach((g, i) => {
      expect(g.ratio).toBeCloseTo(want[i][0] / want[i][1], 2);
      expect(g.long).toBeCloseTo(792, 0);
    });
    // photos have no text, so no signature line was found: like any upload, a signature page was added at the end
    expect(pdf.getPageCount()).toBe(4);

    // cleaned up, and the token can't be used again
    expect(fs.existsSync(blobDir("ws_a", s.id))).toBe(false);
    expect(scan._pagesOf(s.id)).toEqual([]);
    for (const res of [await hello(s.token), await put(s.token, 0, JPG[0]), await del(s.token, 0), await fin(s.token, 3)]) expect(res.status).toBe(410);
    expect(ingestCalls).toHaveLength(1);
  });

  it("finishing needs every page from 0 to count-1; extra pages are dropped; two finishes at once make one draft", async () => {
    const s = await start();
    await put(s.token, 0, JPG[0]);
    await put(s.token, 2, JPG[1]);
    const miss = await fin(s.token, 3);
    expect(miss.status).toBe(409); // page 1 is missing: the phone can upload it and try again
    expect(scan._session(s.id)!.status).toBe("connected");
    for (const c of [0, -1, 1.5]) expect((await fin(s.token, c)).status).toBe(422);
    await put(s.token, 1, JPG[2]);
    await put(s.token, 3, JPG[2]);
    const [a, b] = await Promise.all([fin(s.token, 3), fin(s.token, 3)]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(ingestCalls).toHaveLength(1);
    const v = db.one<{ pdf_path: string }>("SELECT pdf_path FROM template_versions WHERE id = ?", scan._session(s.id)!.result_version_id!)!;
    const pdf = await PDFDocument.load(await storage.getBlob(v.pdf_path));
    expect(pdf.getPageCount()).toBe(3 + 1); // page 3 was not used
  });

  it("someone no longer an admin can't finish a scan they started; the scan fails and is cleaned up", async () => {
    const s = await start(OTHER_ADMIN);
    await put(s.token, 0, JPG[0]);
    db.run("UPDATE members SET role = 'staff' WHERE user_id = ? AND workspace_id = 'ws_a'", OTHER_ADMIN.userId);
    try {
      const r = await fin(s.token, 1);
      expect(r.status).toBe(422);
      // the phone learns only that it failed; the reason is for the desktop
      expect(await r.json()).toEqual({ error: scan.PHONE_BUILD_FAILED });
      expect(ingestCalls).toHaveLength(0);
      const st = (await (await stat(s.id, OTHER_ADMIN)).json()) as { status: string; error: string };
      expect(st.status).toBe("failed");
      expect(st.error).toMatch(/can no longer upload/);
      expect(fs.existsSync(blobDir("ws_a", s.id))).toBe(false);
      expect((await fin(s.token, 1)).status).toBe(410);
    } finally {
      db.run("UPDATE members SET role = 'admin' WHERE user_id = ? AND workspace_id = 'ws_a'", OTHER_ADMIN.userId);
    }
  });

  it("the sweep runs without a worker: closes stale scans, gives up stuck builds, removes old ones", async () => {
    const s = await start();
    await put(s.token, 0, JPG[0]);
    const created = new Date(scan._session(s.id)!.created_at).getTime();
    await scan.sweep(created + 11 * 60_000);
    expect(scan._session(s.id)!.status).toBe("expired");
    expect(fs.existsSync(blobDir("ws_a", s.id))).toBe(false);
    db.run("UPDATE scan_sessions SET status = 'building', building_at = ? WHERE id = ?", new Date(created).toISOString(), s.id);
    await scan.sweep(created + 6 * 60_000);
    expect(scan._session(s.id)!.status).toBe("failed");
    await scan.sweep(created + 25 * 3600_000);
    expect(scan._session(s.id)).toBeUndefined();
  });

  it("has its own rate limits: per token and per address", async () => {
    const s = await start();
    const fixed = "198.51.100.7";
    let last = 0;
    for (let i = 0; i < 151; i++) last = (await connect.POST(new Request(`http://localhost:3000/api/scan/phone/${s.token}`, { method: "POST", headers: { "x-forwarded-for": `${fixed.slice(0, -1)}${i % 9}` } }), tp(s.token))).status;
    expect(last).toBe(429);
    // another scan's token from a fresh address is unaffected
    const s2 = await start();
    expect((await hello(s2.token)).status).toBe(200);
  });

  it("checks the token, the declared length and the server's upload slots before reading any page body", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024);
    const raw = (token: string, body: BodyInit, h: Record<string, string>) =>
      new Request(`http://localhost:3000/api/scan/phone/${token}/pages/0`, { method: "PUT", body, headers: { "x-forwarded-for": ip(), ...h }, duplex: "half" } as RequestInit);
    // unknown token: 404 and the 9 MB body is never touched
    const r1 = raw("x".repeat(43), new Uint8Array(big), { "content-length": String(big.length) });
    expect((await pages.PUT(r1, np("x".repeat(43), 0))).status).toBe(404);
    expect(r1.bodyUsed).toBe(false);
    // a closed scan: 410, body untouched
    const closed = await start();
    current = ADMIN;
    await cancel.POST(req(`/api/scan/session/${closed.id}/cancel`, { method: "POST" }), ip_(closed.id));
    const r2 = raw(closed.token, new Uint8Array(JPG[0]), { "content-length": String(JPG[0].length) });
    expect((await pages.PUT(r2, np(closed.token, 0))).status).toBe(410);
    expect(r2.bodyUsed).toBe(false);
    // an open scan, but no length, or a length over 8 MB: refused unread
    const s = await start();
    const r3 = raw(s.token, new Uint8Array(JPG[0]), {});
    expect((await pages.PUT(r3, np(s.token, 0))).status).toBe(411);
    expect(r3.bodyUsed).toBe(false);
    const r4 = raw(s.token, new Uint8Array(big), { "content-length": String(big.length) });
    expect((await pages.PUT(r4, np(s.token, 0))).status).toBe(413);
    expect(r4.bodyUsed).toBe(false);
    // a body longer than it declared is cut off at the declared length
    const r5 = raw(s.token, new Uint8Array(JPG[0]), { "content-length": "100" });
    expect((await pages.PUT(r5, np(s.token, 0))).status).toBe(413);

    // at most 4 uploads are read at once: four slow ones hold the slots, the fifth is told to retry
    const ctrls: ReadableStreamDefaultController<Uint8Array>[] = [];
    const slow = [0, 1, 2, 3].map((i) => {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void ctrls.push(c) });
      return pages.PUT(raw(s.token, body, { "content-length": String(JPG[i % 3].length) }), np(s.token, i));
    });
    await new Promise((r) => setTimeout(r, 50));
    const fifth = await put(s.token, 4, JPG[0]);
    expect(fifth.status).toBe(503);
    expect(((await fifth.json()) as { error: string }).error).toMatch(/Busy, retry/);
    ctrls.forEach((c, i) => {
      c.enqueue(new Uint8Array(JPG[i % 3]));
      c.close();
    });
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await put(s.token, 4, JPG[0])).status).toBe(200); // the slots are free again
    expect(scan._pagesOf(s.id)).toHaveLength(5);
  });

  it("a sweep while a PDF is being built leaves it alone, and a build closed meanwhile never turns into done", async () => {
    const s = await start();
    await put(s.token, 0, JPG[0]);
    let seen: { status?: string; pages: number; dir: boolean } | null = null;
    duringIngest = async () => {
      // as if the build had been running for 6 minutes: the sweep would call it stuck, but it's running here
      await scan.sweep(Date.now() + 6 * 60_000);
      seen = { status: scan._session(s.id)?.status, pages: scan._pagesOf(s.id).length, dir: fs.existsSync(blobDir("ws_a", s.id)) };
    };
    try {
      expect((await fin(s.token, 1)).status).toBe(200);
    } finally {
      duringIngest = null;
    }
    expect(seen).toEqual({ status: "building", pages: 1, dir: true });
    expect(scan._session(s.id)!.status).toBe("done");

    // a build whose session was closed as failed while it ran stays failed (no result attached)
    const s2 = await start();
    await put(s2.token, 0, JPG[0]);
    duringIngest = async () => {
      db.run("UPDATE scan_sessions SET status = 'failed', error = 'closed elsewhere' WHERE id = ?", s2.id);
    };
    try {
      const r = await fin(s2.token, 1);
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: scan.PHONE_BUILD_FAILED });
    } finally {
      duringIngest = null;
    }
    expect(scan._session(s2.id)).toMatchObject({ status: "failed", error: "closed elsewhere", result_version_id: null });
    expect(fs.existsSync(blobDir("ws_a", s2.id))).toBe(false);
  });

  it("the desktop status and cancel limits are per signed-in user, not per address", async () => {
    const mine = await start(LIMIT_ADMIN);
    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push((await stat(mine.id, LIMIT_ADMIN)).status); // a fresh address every time
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(codes[120]).toBe(429);
    // someone else behind the same addresses isn't affected
    const theirs = await start(OTHER_ADMIN);
    expect((await stat(theirs.id, OTHER_ADMIN)).status).toBe(200);
    // and the limit is checked after the cookie: no session is 401, not 429
    expect((await stat(mine.id, null)).status).toBe(401);
  });

  it("housekeeping runs at most every few seconds, while each request still enforces its own expiry", async () => {
    const s = await start();
    const before = scan._sweepRuns;
    for (let i = 0; i < 20; i++) await scan.phoneView(s.token);
    for (let i = 0; i < 20; i++) await stat(s.id);
    expect(scan._sweepRuns - before).toBeLessThanOrEqual(1);
    // its time passes between sweeps: the very next request says expired anyway
    db.run("UPDATE scan_sessions SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), s.id);
    expect((await hello(s.token)).status).toBe(410);
    expect(((await (await stat(s.id)).json()) as { status: string }).status).toBe("expired");
  });

  it("the phone page counts against the phone limits too", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Page = (await import("../app/scan/[token]/page")).default;
    const s = await start();
    const load = async () => {
      reqHeaders = new Headers({ "x-forwarded-for": ip() });
      return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: s.token }) }));
    };
    const first = await load();
    expect(first).toContain("Photograph the agreement");
    expect(first).not.toContain("Northwind");
    let last = "";
    for (let i = 0; i < 150; i++) last = await load();
    expect(last).toContain("Too many requests");
    expect(last).not.toContain("Photograph the agreement");
    // the same per-token bucket as the phone's API requests
    expect((await hello(s.token)).status).toBe(429);
  });

  describe("nothing logs", () => {
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));
    it("no token, page bytes or error detail reaches the console, even when things go wrong", async () => {
      for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
      const s = await start();
      await hello(s.token);
      await put(s.token, 0, Buffer.from("<svg>not an image</svg>"));
      await put(s.token, 0, JPG[0]);
      // a failure inside the build (the stored page vanished) answers a generic error and logs nothing
      fs.rmSync(blobDir("ws_a", s.id), { recursive: true, force: true });
      const r = await fin(s.token, 1);
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: string }).error).toBe(scan.PHONE_BUILD_FAILED);
      const st = (await (await stat(s.id)).json()) as { error: string };
      expect(st.error).toBe("Making the PDF failed. Start again.");
      for (const sp of spies) expect(sp).not.toHaveBeenCalled();
    });
  });
});
