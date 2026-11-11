import { test, expect, devices, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import jsQR from "jsqr";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// "Sign on your phone": the client opens the signing link on a desktop, asks for the QR code, scans it (decoded here
// with jsQR from the dialog's own image, so the code on screen is proved scannable and to carry the exact link), and
// signs on an emulated phone through the normal flow. The desktop updates itself without a reload. Real phones and
// cameras can't be driven here: the phones are Playwright device emulation (Pixel 7, iPhone 13 on Chromium).

const idOf = (url: string) => new URL(url).pathname.split("/").pop()!;
let ipN = 0;

async function desktopRoom(browser: Browser, link: string) {
  // the desktop and the phone are different devices: each arrives from its own address (see helpers.ts signAsClient)
  const ctx = await browser.newContext({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `203.0.113.${(++ipN % 250) + 1}` });
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole("button", { name: "Review and sign" })).toBeVisible();
  // set once: a full reload would lose it, router.refresh() keeps it
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));
  return { ctx, page };
}
const stillSamePage = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload === 1);

/** Read the QR code the way a phone camera would: from the pixels of the image in the dialog. */
async function scanQr(page: Page): Promise<string> {
  const img = page.getByRole("dialog").getByRole("img", { name: "QR code of this signing link" });
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

async function openPhoneDialog(page: Page) {
  const btn = page.getByRole("button", { name: "Sign on your phone" });
  await expect(btn).toBeVisible();
  await btn.click();
  const d = page.getByRole("dialog", { name: "Sign on your phone" });
  await expect(d).toBeVisible();
  await expect(d).toContainText("Scan with your phone's camera. You'll sign there; this page updates when you're done.");
  await expect(d.getByRole("status")).toContainText("Waiting for you to sign on your phone…");
  return d;
}

const phone = (browser: Browser, device: "Pixel 7" | "iPhone 13"): Promise<BrowserContext> => browser.newContext({ ...devices[device] });

test.describe.serial("sign on your phone", () => {
  let firm: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    firm = await (await browser.newContext()).newPage();
    await signup(firm);
    await uploadAndPublish(firm, "02-msa-two-column.pdf");
    await adoptCountersignature(firm); // the firm countersigns automatically, so signing completes the agreement
  });
  test.afterAll(async () => firm?.context().close());

  for (const device of ["Pixel 7", "iPhone 13"] as const)
    test(`scan on the desktop, sign on a phone (${device}), the desktop updates by itself`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { link } = await newFile(firm, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: `QR-${uid()}` });
      const { ctx, page } = await desktopRoom(browser, link);

      const d = await openPhoneDialog(page);
      const scanned = await scanQr(page);
      expect(scanned, "the QR carries the same signing link, nothing shortened or proxied").toBe(link);

      // the copy-link fallback copies the same link
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
      await d.getByRole("button", { name: "Copy link" }).click();
      await expect(d.getByRole("button", { name: "Link copied ✓" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

      // on the phone there is no "Sign on your phone": it's the phone
      const p = await phone(browser, device);
      const look = await p.newPage();
      await look.goto(scanned);
      await expect(look.getByRole("button", { name: "Review and sign" })).toBeVisible();
      await expect(look.getByRole("button", { name: "Sign on your phone" })).toBeHidden();
      await look.close();

      // sign on the phone through the usual flow; the desktop says so within seconds, without a reload
      const waiting = expect(page.getByRole("dialog", { name: "Signed on your phone" })).toBeVisible({ timeout: 120_000 });
      await signAsClient(p, scanned);
      const signedAt = Date.now();
      await waiting;
      expect(Date.now() - signedAt, "the desktop updated within 15 s of signing").toBeLessThan(15_000);
      const done = page.getByRole("dialog", { name: "Signed on your phone" });
      await expect(done).toContainText(/Thanks — Northwind Advisory (is countersigning now; you'll get the completed copy by email\.|has countersigned too)/);
      expect(await stillSamePage(page)).toBe(true);

      // then the page shows its own state for a signed agreement, still without a reload
      await expect(page.getByRole("heading", { level: 1, name: /^(This agreement is complete|You've signed)$/ })).toBeVisible({ timeout: 20_000 });
      await expect(done).toBeHidden();
      expect(await stillSamePage(page)).toBe(true);

      // reopening the link shows the existing completed state
      const again = await ctx.newPage();
      await again.goto(link);
      await expect(again.getByRole("heading", { level: 1, name: "This agreement is complete" })).toBeVisible();
      await expect(again.getByRole("button", { name: "Sign on your phone" })).toHaveCount(0);
      await p.close();
      await ctx.close();
    });

  test("declined on the phone: the desktop says so (checking in the background, dialog closed)", async ({ browser }) => {
    test.setTimeout(120_000);
    const { link } = await newFile(firm, { name: "Casey Placeholder", email: `client-${uid()}@example.com`, ref: `QR-${uid()}` });
    const { ctx, page } = await desktopRoom(browser, link);
    const d = await openPhoneDialog(page);
    const scanned = await scanQr(page);
    await d.getByRole("button", { name: "Close" }).click();
    await expect(d).toBeHidden();

    const p = await phone(browser, "Pixel 7");
    await p.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${(++ipN % 250) + 1}` });
    const m = await p.newPage();
    await m.goto(scanned);
    await m.getByRole("button", { name: "I don't want to sign this" }).click();
    await m.getByRole("dialog").locator("textarea").fill("Synthetic: wrong fee schedule");
    await m.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
    await expect(m.getByRole("dialog").getByRole("heading", { name: "Declined" })).toBeVisible();
    const declinedAt = Date.now();

    // the background check runs every 10 s while the page is visible
    const out = page.getByRole("dialog", { name: "You declined this agreement" });
    await expect(out).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - declinedAt).toBeLessThan(15_000);
    await expect(out).toContainText("We let Northwind Advisory know.");
    await out.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "You declined this agreement" })).toBeVisible();
    expect(await stillSamePage(page)).toBe(true);
    await p.close();
    await ctx.close();
  });

  test("an expired link: the desktop says so, and network trouble shows Reconnecting", async ({ browser }) => {
    test.setTimeout(120_000);
    const { link, fileUrl } = await newFile(firm, { name: "Morgan Sample", email: `client-${uid()}@example.com`, ref: `QR-${uid()}` });
    const { ctx, page } = await desktopRoom(browser, link);

    // the status check fails: the dialog says it's reconnecting, and carries on once the network is back
    const d = await openPhoneDialog(page);
    await page.route("**/api/sign/*/status", (r) => r.abort("internetdisconnected"));
    await expect(d.getByRole("status")).toContainText("Reconnecting…", { timeout: 10_000 });
    await page.unroute("**/api/sign/*/status");

    // the link's date passes (as time would)
    const db = new DatabaseSync(".e2e-data/countersign.db");
    db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), idOf(fileUrl));
    db.close();

    const out = page.getByRole("dialog", { name: "This link has expired" });
    await expect(out).toBeVisible({ timeout: 40_000 });
    await expect(out).toContainText("Ask Northwind Advisory to send it again.");
    await expect(page.getByRole("heading", { level: 1, name: "This link has expired" })).toBeVisible({ timeout: 20_000 });
    expect(await stillSamePage(page)).toBe(true);
    await ctx.close();
  });
});
