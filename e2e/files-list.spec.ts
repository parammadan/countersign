import { test, expect, devices, type Page } from "@playwright/test";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// The files list: tabs and search return the same files as the query always did, tab counts match the list
// (search included), the two empty states differ, the counts are readable (AA), and nothing scrolls
// sideways on a phone or tablet.

const rows = (page: Page) => page.locator("main ul.divide-y > li");
const tabLink = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Filter files by status" }).getByRole("link", { name });

// WCAG contrast ratio of an element's text colour against the first opaque-ish background behind it,
// blending translucent layers (the active chip is brand at 10%) over the page's white panel.
const contrast = (loc: ReturnType<Page["locator"]>) =>
  loc.evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) { const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean); return [+r, +g, +b, +a]; }
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const layers: number[][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.unshift(c);
      if (c[3] >= 1) break;
    }
    let bg = [255, 255, 255];
    for (const [r, g, b, a] of layers) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const fgc = parse(getComputedStyle(el).color);
    const fg = [0, 1, 2].map((i) => fgc[i] * fgc[3] + bg[i] * (1 - fgc[3]));
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("tabs, counts, search and empty states", async ({ page }) => {
  await signup(page, "Northwind Advisory", "Northwind Advisory, LLC");
  await page.goto("/app/files");
  await expect(page.getByText("No files yet", { exact: true })).toBeVisible();

  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const tag = uid();
  await newFile(page, { name: "Riley Example", email: `riley-${tag}@example.com`, ref: `FL-A-${tag}` });
  await newFile(page, { name: "Casey Placeholder", email: `casey-${tag}@example.com`, ref: `FL-B-${tag}` });
  const voided = await newFile(page, { name: "Jordan Sample", email: `jordan-${tag}@example.com`, ref: `FL-C-${tag}` });
  await page.goto(voided.fileUrl);
  await page.getByRole("button", { name: "Void", exact: true }).click();
  await page.getByLabel("Reason for voiding").fill("Synthetic: test file");
  await page.getByRole("button", { name: "Void file" }).click();
  await expect(page.getByRole("heading", { name: "This file was voided" })).toBeVisible();

  await page.goto("/app/files");
  await expect(rows(page)).toHaveCount(3);
  const nav = page.getByRole("navigation", { name: "Filter files by status" });
  await expect(tabLink(page, /^All\s*3 files$/)).toHaveAttribute("aria-current", "page");
  await expect(tabLink(page, /^Waiting on client\s*2 files$/)).toBeVisible();
  await expect(tabLink(page, /^Declined \/ expired \/ voided\s*1 file$/)).toBeVisible();
  await expect(tabLink(page, /^Completed\s*0 files$/)).toBeVisible();

  // the counts carry information, so they must pass AA (4.5:1) against their chip, inactive and active.
  // axe reports these nodes as "incomplete", so it can't be relied on here.
  const countOf = (name: RegExp) => tabLink(page, name).locator("span.tabular");
  expect(await contrast(countOf(/^Completed/)), "inactive tab count").toBeGreaterThanOrEqual(4.5);
  expect(await contrast(countOf(/^All/)), "active tab count").toBeGreaterThanOrEqual(4.5);

  await nav.getByRole("link", { name: /^Declined/ }).click();
  await expect(page).toHaveURL(/status=closed/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Jordan Sample");
  await expect(rows(page).first()).toContainText("Voided");

  await nav.getByRole("link", { name: /^Waiting on client/ }).click();
  await expect(page).toHaveURL(/status=open/);
  await expect(rows(page)).toHaveCount(2);

  await nav.getByRole("link", { name: /^Completed/ }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("Nothing in this view", { exact: true })).toBeVisible();

  // search narrows by client name, ref and email, keeps the tab, and the tab counts follow it
  await page.goto("/app/files?status=open");
  await page.getByLabel("Search files").fill("Riley");
  await page.getByLabel("Search files").press("Enter");
  await expect(page).toHaveURL(/status=open&q=Riley|q=Riley.*status=open/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Riley Example");
  await expect(page.getByText("1 file matching")).toBeVisible();
  await expect(tabLink(page, /^All\s*1 file$/)).toBeVisible();
  await expect(tabLink(page, /^Waiting on client\s*1 file$/)).toHaveAttribute("aria-current", "page");
  await expect(tabLink(page, /^Declined \/ expired \/ voided\s*0 files$/)).toBeVisible();
  await page.goto(`/app/files?q=FL-B-${tag}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Casey Placeholder");
  await page.goto(`/app/files?q=${encodeURIComponent(`jordan-${tag}@example`)}`);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Jordan Sample");
  await expect(tabLink(page, /^All\s*1 file$/)).toBeVisible();
  await expect(tabLink(page, /^Declined \/ expired \/ voided\s*1 file$/)).toBeVisible();
  await expect(tabLink(page, /^Waiting on client\s*0 files$/)).toBeVisible();

  await page.goto("/app/files?q=zzz-no-such-client");
  await expect(page.getByText("No files match that search", { exact: true })).toBeVisible();
  await expect(tabLink(page, /^All\s*0 files$/)).toBeVisible();
  await page.getByRole("link", { name: "Clear search" }).click();
  await expect(rows(page)).toHaveCount(3);

  // a row still links to its file
  await rows(page).first().getByRole("link").click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
});

for (const [name, use] of [["small phone 360", { ...devices["Pixel 7"], viewport: { width: 360, height: 740 } }], ["Pixel 7", devices["Pixel 7"]], ["iPad Mini", devices["iPad Mini"]]] as const) {
  test(`no sideways scroll on ${name}`, async ({ browser }) => {
    const ctx = await browser.newContext(use);
    const page = await ctx.newPage();
    await signup(page, "Northwind Advisory", "Northwind Advisory, LLC");
    await page.goto("/app/files");
    expect(await overflow(page), "empty").toBeLessThanOrEqual(0);
    await uploadAndPublish(page, "02-msa-two-column.pdf");
    await adoptCountersignature(page);
    await newFile(page, { name: "Riley Example With A Rather Long Name Indeed", email: `riley-${uid()}@example.com`, ref: `FL-${uid()}` });
    await page.goto("/app/files");
    await expect(rows(page)).toHaveCount(1);
    expect(await overflow(page), "with a file").toBeLessThanOrEqual(0);
    await ctx.close();
  });
}
