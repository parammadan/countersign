import { test, expect, devices, type Page, type Locator } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// No sideways scrolling on the landing page and the file page (sent and completed), and every control
// on them stays on screen, at phone and tablet widths. The client signs on each device too.

const SIZES = [
  { name: "small phone 360", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 740 } } },
  { name: "Pixel 7", use: devices["Pixel 7"] },
  { name: "iPad Mini", use: devices["iPad Mini"] },
  { name: "laptop 1024", use: { viewport: { width: 1024, height: 768 } } },
];

const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function onScreen(page: Page, loc: Locator, what: string) {
  await expect(loc, what).toBeVisible();
  const box = (await loc.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x, `${what}: starts off screen`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what}: runs off the right edge`).toBeLessThanOrEqual(width + 0.5);
}

test("landing page fits every width", async ({ browser }) => {
  for (const size of SIZES) {
    const ctx = await browser.newContext(size.use);
    const page = await ctx.newPage();
    await page.goto("/");
    expect(await overflow(page), `${size.name}: landing scrolls sideways`).toBeLessThanOrEqual(0);
    await onScreen(page, page.getByRole("heading", { level: 1 }), `${size.name}: headline`);
    await onScreen(page, page.getByRole("main").getByRole("link", { name: "Create workspace" }).first(), `${size.name}: primary call to action`);
    await onScreen(page, page.getByRole("banner").getByRole("link", { name: "Sign in" }), `${size.name}: header sign in`);
    await ctx.close();
  }
});

test("file page fits every width, sent and completed, and the client can sign on each", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const state = await page.context().storageState();

  for (const size of SIZES) {
    // a long name, address and reference: the worst case for wrapping
    const file = await newFile(page, { name: "Jordan Sample-Placeholder with a fairly long name", email: `a-very-long-client-address-${uid()}@example.com`, ref: `RESP-${uid()}-${uid()}` });
    const ctx = await browser.newContext({ ...size.use, storageState: state });
    const firm = await ctx.newPage();

    await firm.goto(file.fileUrl);
    expect(await overflow(firm), `${size.name}: sent file page scrolls sideways`).toBeLessThanOrEqual(0);
    await onScreen(firm, firm.getByRole("button", { name: "Send reminder" }), `${size.name}: Send reminder`);
    await onScreen(firm, firm.getByRole("button", { name: "Copy signing link" }), `${size.name}: Copy signing link`);
    await onScreen(firm, firm.getByRole("button", { name: "Void" }), `${size.name}: Void`);
    // the link itself is never printed: only a masked hint, and Copy gives the full link
    await expect(firm.getByText(file.link)).toHaveCount(0);
    await onScreen(firm, firm.getByText(/\/s\/••••••••/), `${size.name}: masked signing link`);
    await firm.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await firm.getByRole("button", { name: "Copy signing link" }).click();
    expect(await firm.evaluate(() => navigator.clipboard.readText()), "Copy gives the full signing link").toBe(file.link);

    // the client signs on the same kind of device
    const client = await browser.newContext(size.use);
    const room = await client.newPage();
    await room.goto(file.link);
    expect(await overflow(room), `${size.name}: signing room scrolls sideways`).toBeLessThanOrEqual(0);
    await onScreen(room, room.getByRole("checkbox"), `${size.name}: consent checkbox`);
    await onScreen(room, room.getByRole("button", { name: "Review and sign" }), `${size.name}: Review and sign`);
    await room.close();
    await signAsClient(client, file.link);
    await client.close();

    await firm.goto(file.fileUrl);
    await expect(firm.getByRole("heading", { name: "Ready for work" })).toBeVisible();
    expect(await overflow(firm), `${size.name}: completed file page scrolls sideways`).toBeLessThanOrEqual(0);
    await onScreen(firm, firm.getByRole("link", { name: /Download/ }).first(), `${size.name}: Download signed PDF`);
    await onScreen(firm, firm.getByRole("heading", { name: "Activity" }), `${size.name}: activity heading`);
    await ctx.close();
  }
});
