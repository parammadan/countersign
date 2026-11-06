import { test, expect, devices, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// Automated accessibility checks (WCAG 2.1 A + AA rules in axe-core) on every main screen, signed out,
// signed in and on the client's signing pages. Axe can't judge everything (focus order, wording), so this is
// a floor, not a certificate.

async function audit(page: Page, name: string, opts: { exclude?: string[] } = {}) {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const sel of opts.exclude ?? []) b = b.exclude(sel);
  const r = await b.analyze();
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes[0]?.target.join(" ")} | ${v.help}`);
  expect.soft(found, `${name} has accessibility violations`).toEqual([]);
}

test("public pages", async ({ page }) => {
  for (const [path, name] of [["/", "landing"], ["/login", "login"], ["/signup", "signup"], ["/forgot", "forgot"], ["/verify", "verify"]]) {
    await page.goto(path);
    await audit(page, name);
  }
});

test("app pages and the signing room", async ({ page, browser }) => {
  await signup(page);
  await audit(page, "dashboard (empty)");
  for (const p of ["/app/agreements", "/app/files", "/app/outbox", "/app/developers", "/app/settings"]) {
    await page.goto(p);
    await audit(page, p);
  }
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  await page.goto("/app/files/new");
  await audit(page, "new file");
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: "A11Y-1" });
  await audit(page, "file page");
  await page.goto("/app");
  await audit(page, "dashboard (with a file)");

  const m = await browser.newContext({ ...devices["Pixel 7"] });
  const c = await m.newPage();
  await c.goto(link);
  await audit(c, "signing intro (phone)");
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();
  await expect(c.getByRole("button", { name: /^Next field$/ })).toBeVisible();
  // the PDF text layer is rendered by pdf.js and is the client's own document, so it is excluded
  await audit(c, "signing document (phone)", { exclude: ["canvas"] });
  await m.close();
});

test("field editor", async ({ page }) => {
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles("fixtures/agreements/02-msa-two-column.pdf");
  await page.waitForURL(/agreements\/tv_/);
  await expect(page.getByText("found automatically")).toBeVisible();
  await audit(page, "field editor", { exclude: ["canvas"] });
  // a selected field, placing mode and the publish dialog
  await page.locator("[data-field-id]").first().click();
  await expect(page.getByRole("heading", { name: "Selected field" })).toBeVisible();
  await page.getByRole("button", { name: "Client initials" }).click();
  await expect(page.getByLabel("Page to place it on")).toBeVisible();
  await audit(page, "field editor (selected, placing)", { exclude: ["canvas"] });
  await page.getByRole("button", { name: "Review and publish" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await audit(page, "publish dialog", { exclude: ["canvas"] });
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("dialog").getByRole("button", { name: /^Publish version/ }).click();
  await page.waitForURL(/published=1/);
  // the library with a live agreement, its history and an archived view
  await audit(page, "agreement library");
  await page.goto("/app/agreements?view=archived");
  await audit(page, "agreement library (archived, empty)");
});
