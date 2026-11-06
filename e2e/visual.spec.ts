import { test, expect, devices, type Page } from "@playwright/test";
import { adoptCountersignature, newFile, uploadAndPublish } from "./helpers";

// Visual regression: key screens on desktop and on a phone, compared against committed baselines.
// Screenshots differ slightly between operating systems (font rendering), so the baselines are per-OS and
// this suite is opt-in: VISUAL=1 npx playwright test e2e/visual.spec.ts   (add --update-snapshots after an
// intended design change, then review the new images before committing them).
test.skip(!process.env.VISUAL, "set VISUAL=1 to run the visual regression suite");

// anything that changes run to run: generated emails, times, ids in links
function dynamic(page: Page) {
  return [
    page.getByText(/\b\d{1,2}:\d{2}\s?(AM|PM)\b|just now|\bago\b|\bUTC\b|\d{4}-\d{2}-\d{2}/),
    page.locator('a[href*="/s/"], code'),
    // the signing link is a random token whose rendered width varies, so mask its whole line
    page.locator("p, div").filter({ hasText: /^Signing link:/ }),
  ];
}
// Fixed synthetic identities, so text widths (and form values) are identical every run. The test server's
// database starts empty on each run, so these never collide.
async function signupFixed(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Firm name").fill("Northwind Advisory");
  await page.getByLabel("Legal entity name").fill("Northwind Advisory, LLC");
  await page.getByLabel("Your name").fill("Avery Tester");
  await page.getByLabel("Work email").fill("owner-visual@example.com");
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

const shot = (page: Page, name: string, fullPage = true) =>
  expect(page).toHaveScreenshot(`${name}.png`, { fullPage, mask: dynamic(page), maxDiffPixels: 20, animations: "disabled" });

test("public screens", async ({ page }) => {
  await page.goto("/");
  await shot(page, "landing");
  await page.goto("/login");
  await shot(page, "login");
  await page.goto("/signup");
  await shot(page, "signup");
});

test("app screens, desktop and phone", async ({ page, browser }) => {
  await signupFixed(page);
  await shot(page, "overview-empty");
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await page.goto("/app/agreements");
  await shot(page, "agreements");
  await adoptCountersignature(page);
  await page.goto("/app/files/new");
  await shot(page, "new-file");
  const { link } = await newFile(page, { name: "Jordan Sample", email: "client-visual@example.com", ref: "2026-0142" });
  await shot(page, "file");
  await page.goto("/app");
  await shot(page, "overview");
  await page.goto("/app/settings");
  await shot(page, "settings");

  // the same workspace on a phone: shell, menu, overview
  const phone = await browser.newContext({ ...devices["Pixel 7"], storageState: await page.context().storageState() });
  const m = await phone.newPage();
  await m.goto("/app");
  await shot(m, "phone-overview");
  await m.getByRole("button", { name: "Open menu" }).click();
  await expect(m.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await shot(m, "phone-menu", false);
  await phone.close();

  // the client's side on a phone
  const client = await browser.newContext({ ...devices["Pixel 7"] });
  const c = await client.newPage();
  await c.goto(link);
  await shot(c, "phone-sign-intro");
  await client.close();
});
