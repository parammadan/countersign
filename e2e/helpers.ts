import { expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";

export const uid = () => Math.random().toString(36).slice(2, 8);

export async function signup(page: Page, firm = "Northwind Advisory", legal = "Northwind Advisory, LLC") {
  const email = `owner-${uid()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Firm name").fill(firm);
  await page.getByLabel("Legal entity name").fill(legal);
  await page.getByLabel("Your name").fill("Avery Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  return email;
}

export async function uploadAndPublish(page: Page, fixture: string) {
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(path.isAbsolute(fixture) ? fixture : path.join(process.cwd(), "fixtures/agreements", fixture));
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  await expect(page.getByText("found automatically")).toBeVisible();
  await publishDraft(page);
}

/** Publish the open draft through the confirmation dialog (it asks the admin to confirm they checked the fields). */
export async function publishDraft(page: Page) {
  await page.getByRole("button", { name: "Review and publish" }).click();
  const d = page.getByRole("dialog");
  await d.getByRole("checkbox").check();
  await d.getByRole("button", { name: /^Publish version \d+/ }).click();
  await expect(page).toHaveURL(/published=1/);
}

export async function adoptCountersignature(page: Page) {
  await page.goto("/app/settings");
  const box = page.locator("#countersign");
  await box.getByPlaceholder("Full name").fill("Avery Tester");
  await box.getByPlaceholder("Managing Partner").fill("Managing Partner");
  await box.getByRole("button", { name: "Adopt signature" }).click();
  await expect(page.getByText("Countersignature adopted")).toBeVisible();
}

export async function newFile(page: Page, client: { name: string; email: string; ref?: string }) {
  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill(client.name);
  await page.getByLabel("Client email").fill(client.email);
  if (client.ref) await page.getByLabel("File / matter reference").fill(client.ref);
  for (const input of await page.locator('input[name^="prefill."]').all()) await input.fill("Test value");
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  const link = await copySigningLink(page);
  return { fileUrl: page.url(), link };
}

/** The signing link, the way a firm user gets it: Copy signing link, then read the clipboard. The page never prints it. */
export async function copySigningLink(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy signing link" }).click();
  await expect(page.getByRole("button", { name: "Link copied ✓" })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/);
  return link;
}

export async function signAsClient(ctx: BrowserContext, link: string) {
  const page = await ctx.newPage();
  await page.goto(link);
  // a client who already consented (consent is saved on the server) goes straight to the fields
  const review = page.getByRole("button", { name: "Review and sign" });
  await expect(review.or(page.getByRole("button", { name: /^Next field$/ })).first()).toBeVisible();
  if (await review.isVisible()) {
    await page.getByRole("checkbox").check();
    await review.click();
  }
  for (let i = 0; i < 40; i++) {
    if (await page.getByRole("button", { name: /^Finish/ }).first().isVisible().catch(() => false)) break;
    await page.getByRole("button", { name: /^Next field$/ }).click();
    await page.waitForTimeout(400);
    await page.locator("[data-fid]:focus").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 }).catch(() => {});
    const adopt = dialog.getByRole("button", { name: /Adopt (signature|initials)/ });
    const save = dialog.getByRole("button", { name: "Save" });
    if (await adopt.isVisible().catch(() => false)) await adopt.click();
    else if (await save.isVisible().catch(() => false)) {
      const input = dialog.locator("input");
      if (!(await input.inputValue())) await input.fill("Test entry");
      await save.click();
    }
    await expect(dialog).toBeHidden();
  }
  await page.getByRole("button", { name: /^Finish/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign and finish" }).click();
  await expect(page.getByRole("heading", { name: "All signed" })).toBeVisible({ timeout: 60_000 });
  return page;
}
