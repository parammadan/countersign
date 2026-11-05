import { test, devices } from "@playwright/test";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

const OUT = process.env.SHOTS_DIR;
test.skip(!OUT, "set SHOTS_DIR to capture screenshots");

test("capture key screens", async ({ page, browser }) => {
  await signup(page);
  await page.screenshot({ path: `${OUT}/01-dashboard-empty.png`, fullPage: true });
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles("fixtures/agreements/02-msa-two-column.pdf");
  await page.waitForURL(/agreements\/tv_/);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/02-editor.png` });
  await page.locator('[data-page="3"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/03-editor-sigpage.png` });
  await page.getByRole("button", { name: /publish/i }).click();
  await page.waitForURL(/published=1/);
  await adoptCountersignature(page);
  const { fileUrl, link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: "2026-0142" });
  await page.screenshot({ path: `${OUT}/04-file.png`, fullPage: true });
  const m = await browser.newContext({ ...devices["Pixel 7"] });
  const c = await m.newPage();
  await c.goto(link);
  await c.screenshot({ path: `${OUT}/05-sign-intro-mobile.png`, fullPage: true });
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();
  await c.waitForTimeout(2000);
  await c.getByRole("button", { name: "Next field" }).click();
  await c.waitForTimeout(1200);
  await c.screenshot({ path: `${OUT}/06-sign-doc-mobile.png` });
  await c.locator("[data-fid]:focus").click();
  await c.waitForTimeout(600);
  await c.screenshot({ path: `${OUT}/07-sign-pad-mobile.png` });
  await page.goto("/app");
  await page.screenshot({ path: `${OUT}/08-dashboard.png`, fullPage: true });
  for (const [name, url] of [["09-settings", "/app/settings"], ["10-developers", "/app/developers"], ["11-agreements", "/app/agreements"], ["12-files", "/app/files"], ["13-outbox", "/app/outbox"]] as const) {
    await page.goto(url);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }
  const anon = await browser.newContext();
  const a = await anon.newPage();
  await a.goto("/");
  await a.screenshot({ path: `${OUT}/14-landing.png`, fullPage: true });
  void fileUrl;
});
