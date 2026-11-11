import { test, expect, devices, type Browser, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import crypto from "node:crypto";
import jsQR from "jsqr";
import { signup } from "./helpers";

// "Scan with phone": an admin on a desktop opens the dialog, the QR code is read from the dialog's own image with
// jsQR (so the code on screen is proved to scan and to carry the phone link), and an emulated phone (Pixel 7,
// iPhone 13: Playwright device emulation on Chromium, not real devices or cameras) opens it, adds generated photos
// through the page's file inputs, turns, reorders and deletes pages, and sends them. The desktop moves on by itself
// to the new draft's field editor. Nothing is published or sent.

let ipN = 0;
const addr = () => `203.0.113.${(++ipN % 250) + 1}`;

// ---- synthetic photos: solid-colour PNGs of distinct sizes (the phone page turns them into JPEGs) ----
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
function png(w: number, h: number, rgb: [number, number, number]) {
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) row.set(((x >> 5) & 1 ? [250, 250, 250] : rgb), 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PORTRAIT = { name: "page-1.png", mimeType: "image/png", buffer: png(600, 800, [40, 90, 200]) };
const LANDSCAPE = { name: "page-2.png", mimeType: "image/png", buffer: png(800, 500, [200, 60, 40]) };
const SQUARE = { name: "page-3.jpg", mimeType: "image/png", buffer: png(500, 500, [40, 160, 80]) }; // a PNG named .jpg

async function desktop(browser: Browser) {
  const ctx = await browser.newContext({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": addr() });
  return ctx.newPage();
}

/** Read the QR code the way a phone camera would: from the pixels of the image in the dialog. */
async function scanQr(page: Page): Promise<string> {
  const img = page.getByRole("dialog", { name: "Scan with your phone" }).getByRole("img", { name: "QR code to scan pages with your phone" });
  await expect(img).toBeVisible();
  expect(await img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  const { w, data } = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const size = 400;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = false;
    g.drawImage(el, 40, 40, 320, 320);
    return { w: size, data: Array.from(g.getImageData(0, 0, size, size).data) };
  });
  const code = jsQR(Uint8ClampedArray.from(data), w, w);
  expect(code, "the QR code on screen decodes").not.toBeNull();
  return code!.data;
}

async function openScan(page: Page) {
  await page.goto("/app/agreements");
  const panel = page.locator("details#upload");
  if (await panel.count()) await panel.locator("summary").click(); // a library already exists: the upload panel
  await page.getByRole("button", { name: "Scan with phone" }).click();
  const d = page.getByRole("dialog", { name: "Scan with your phone" });
  await expect(d).toBeVisible();
  await expect(d.getByTestId("scan-status")).toHaveText("Waiting for your phone…");
  await expect(d.getByTestId("scan-countdown")).toHaveText(/^The code works for (10:00|9:\d\d)\.$/);
  const link = await scanQr(page);
  expect(link).toMatch(/^http:\/\/localhost:3100\/scan\/[A-Za-z0-9_-]{43}$/);
  return { d, link };
}

const sql = <T>(q: string, ...p: string[]) => {
  const db = new DatabaseSync(".e2e-data/countersign.db");
  try {
    return db.prepare(q).all(...p) as T[];
  } finally {
    db.close();
  }
};
const exec = (q: string, ...p: string[]) => {
  const db = new DatabaseSync(".e2e-data/countersign.db");
  try {
    db.prepare(q).run(...p);
  } finally {
    db.close();
  }
};
/** the stored form of a scan link's token (lib/scan.ts) */
const hashOf = (link: string) => crypto.createHash("sha256").update(`scan:${new URL(link).pathname.split("/").pop()}`).digest("hex");

test.describe.serial("scan with phone", () => {
  let firm: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    firm = await desktop(browser);
    await signup(firm);
  });
  test.afterAll(async () => firm?.context().close());

  for (const device of ["Pixel 7", "iPhone 13"] as const)
    test(`photograph pages on a phone (${device}); the desktop opens the draft by itself`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { d, link } = await openScan(firm);

      const ctx = await browser.newContext({ ...devices[device] });
      await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
      const phone = await ctx.newPage();
      await phone.goto(link);
      await expect(phone.getByRole("heading", { name: "Photograph the agreement" })).toBeVisible();
      // the phone page says nothing about the workspace
      await expect(phone.locator("body")).not.toContainText("Northwind");
      expect(await phone.locator('meta[name="robots"]').getAttribute("content")).toMatch(/noindex/);
      expect(await phone.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");
      await expect(d.getByTestId("scan-status")).toContainText("Phone connected", { timeout: 10_000 });

      // two from the library, one "taken" with the camera input
      await phone.getByTestId("scan-choose-input").setInputFiles([PORTRAIT, LANDSCAPE]);
      await expect(phone.getByTestId("scan-count")).toHaveText("2 pages");
      await phone.getByTestId("scan-camera-input").setInputFiles([SQUARE]);
      await expect(phone.getByTestId("scan-count")).toHaveText("3 pages");
      await expect(phone.getByRole("img", { name: "Page 3" })).toBeVisible();

      // turn page 2 (landscape → portrait), move page 3 up, delete page 1: square, then the turned one
      await phone.getByRole("button", { name: "Rotate page 2" }).click();
      await expect(phone.getByRole("img", { name: "Page 2" })).toHaveAttribute("data-rot", "1");
      await phone.getByRole("button", { name: "Move page 3 up" }).click();
      await expect(phone.getByRole("img", { name: "Page 3" })).toHaveAttribute("data-rot", "1");
      await phone.getByRole("button", { name: "Delete page 1" }).click();
      await expect(phone.getByTestId("scan-count")).toHaveText("2 pages");
      await expect(phone.getByRole("img", { name: "Page 2" })).toHaveAttribute("data-rot", "1");

      // what goes over the wire: JPEGs only, never the original PNGs
      const types: string[] = [];
      phone.on("request", (r) => r.method() === "PUT" && types.push(r.headers()["content-type"] ?? ""));

      await phone.getByRole("button", { name: "Send to computer (2 pages)" }).click();
      await expect(phone.getByTestId("scan-sent")).toContainText("Sent. You can close this page.", { timeout: 60_000 });
      expect(types).toEqual(["image/jpeg", "image/jpeg"]);

      // the desktop moved on by itself, to the field editor of a new draft: 2 photos + the added signature page
      await expect(firm).toHaveURL(/\/app\/agreements\/tv_[A-Za-z0-9_-]+$/, { timeout: 30_000 });
      await expect(firm.getByText("Page 1 of 3")).toBeVisible({ timeout: 30_000 });
      await expect(firm.getByRole("heading", { level: 1 })).toHaveText(/^Check the fields in “Scanned agreement”$/);
      const vid = new URL(firm.url()).pathname.split("/").pop()!;
      const [v] = sql<{ status: string; template_id: string; pages_json: string; source_name: string }>("SELECT status, template_id, pages_json, source_name FROM template_versions WHERE id = ?", vid);
      expect(v.status).toBe("draft");
      expect(v.source_name).toBe("Scanned agreement.pdf");
      const [t] = sql<{ active_version_id: string | null }>("SELECT active_version_id FROM templates WHERE id = ?", v.template_id);
      expect(t.active_version_id, "nothing published").toBeNull();
      expect(sql<{ n: number }>("SELECT COUNT(*) n FROM files WHERE workspace_id = (SELECT workspace_id FROM templates WHERE id = ?)", v.template_id)[0].n, "nothing sent").toBe(0);
      // page order and rotation survived: the square first, then the landscape photo turned upright (500 x 800)
      const pg = JSON.parse(v.pages_json) as { width: number; height: number }[];
      expect(pg).toHaveLength(3);
      expect(pg[0].width / pg[0].height).toBeCloseTo(1, 2);
      expect(pg[1].width / pg[1].height).toBeCloseTo(500 / 800, 2);
      expect(Math.max(pg[0].width, pg[0].height)).toBeCloseTo(792, 0);

      // the link is used up
      await phone.goto(link);
      await expect(phone.getByTestId("scan-gone")).toContainText("This scan has ended");
      await ctx.close();
    });

  test("closing the dialog cancels the scan; an expired code offers Start again with a new code", async ({ browser }) => {
    test.setTimeout(120_000);
    const first = await openScan(firm);
    await first.d.getByRole("button", { name: "Close" }).click();
    await expect(first.d).toBeHidden();
    const ctx = await browser.newContext({ ...devices["Pixel 7"] });
    await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
    const phone = await ctx.newPage();
    await expect
      .poll(async () => {
        await phone.goto(first.link);
        return phone.locator("main").textContent();
      }, { timeout: 10_000 })
      .toContain("This scan has ended");

    // a fresh one, then its ten minutes pass (as time would)
    const second = await openScan(firm);
    expect(second.link).not.toBe(first.link);
    exec("UPDATE scan_sessions SET expires_at = ? WHERE token_hash = ?", new Date(Date.now() - 1000).toISOString(), hashOf(second.link));
    await expect(second.d.getByTestId("scan-status")).toHaveText("The code expired before the pages arrived.", { timeout: 15_000 });
    await phone.goto(second.link);
    await expect(phone.getByTestId("scan-gone")).toContainText("This scan link has expired");
    await second.d.getByRole("button", { name: "Start again" }).click();
    await expect(second.d.getByTestId("scan-status")).toHaveText("Waiting for your phone…");
    expect(await scanQr(firm)).not.toBe(second.link);
    await second.d.getByRole("button", { name: "Close" }).click();
    await ctx.close();
  });
});
