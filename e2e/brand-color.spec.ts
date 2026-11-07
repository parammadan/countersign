import { test, expect, type Locator } from "@playwright/test";
import { newFile, signup, uid, uploadAndPublish } from "./helpers";

// Q8-13: a workspace that picks a light brand colour (#f5c400) made the client's buttons unreadable
// (white on yellow, 1.64:1). The colour is now darkened where it's rendered, keeping its hue, to at least 4.5:1.
// Measured from the computed colours the browser actually paints.

async function contrast(el: Locator) {
  return el.evaluate((node) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const cs = getComputedStyle(node);
    const [a, b] = [lum(parse(cs.color)), lum(parse(cs.backgroundColor))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("a light brand colour still gives readable buttons, for the firm and the client", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "05-drawn-lines-label-under.pdf");
  await page.goto("/app/settings");
  await page.locator('input[name="brand_color"]').fill("#f5c400");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(page.locator('input[name="brand_color"]')).toHaveValue("#f5c400"); // the choice itself is kept

  // the firm's primary button
  await page.goto("/app/files/new");
  const create = page.getByRole("button", { name: "Create and send for signature" });
  expect(await contrast(create)).toBeGreaterThanOrEqual(4.5);

  // the client's signing page
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await c.goto(link);
  await c.getByRole("checkbox").check();
  const review = c.getByRole("button", { name: "Review and sign" });
  expect(await contrast(review), "Review and sign").toBeGreaterThanOrEqual(4.5);
  const firm = c.locator("header span").first(); // the firm name in the brand colour, on white
  await expect(firm).toHaveText("Northwind Advisory");
  expect(await firm.evaluate((n) => getComputedStyle(n).color)).not.toBe("rgb(245, 196, 0)");
  await review.click();
  expect(await contrast(c.getByRole("button", { name: /^Next field$/ })), "Next field").toBeGreaterThanOrEqual(4.5);
  await ctx.close();
});
