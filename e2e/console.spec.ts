import { test, expect } from "@playwright/test";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// No console errors (CSP violations, hydration errors, failed requests) on the main screens.
test("main screens log no console errors", async ({ page, browser }) => {
  const errors: string[] = [];
  const watch = (p: import("@playwright/test").Page) => {
    p.on("console", (m) => m.type() === "error" && errors.push(`${p.url()} :: ${m.text()}`));
    p.on("pageerror", (e) => errors.push(`${p.url()} :: ${e.message}`));
  };
  watch(page);
  await page.goto("/");
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const { fileUrl, link } = await newFile(page, { name: "Jordan Sample", email: `c-${uid()}@example.com` });
  for (const u of ["/app", "/app/files", "/app/agreements", "/app/settings", "/app/developers", "/app/outbox", fileUrl, "/verify"]) {
    await page.goto(u);
    await page.waitForLoadState("networkidle");
  }
  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  watch(c);
  await c.goto(link);
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();
  await c.waitForTimeout(2500);
  await ctx.close();
  expect(errors, errors.join("\n")).toEqual([]);
});
