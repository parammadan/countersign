import { test, expect } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { newFile, signup, uid, uploadAndPublish } from "./helpers";

test("create and revoke an API key; the key is shown once", async ({ page }) => {
  await signup(page);
  await page.goto("/app/developers");
  await expect(page.getByText("No API keys yet")).toBeVisible();
  await page.getByLabel("Key name").fill("CRM sync");
  await page.getByRole("button", { name: "Create API key" }).click();
  const secret = (await page.locator("code", { hasText: /^cs_live_/ }).first().textContent())!.trim();
  expect(secret).toMatch(/^cs_live_/);
  await expect(page.getByText("This is the only time it is shown")).toBeVisible();

  const keys = page.getByRole("list", { name: "API keys" });
  await expect(keys.getByText("CRM sync")).toBeVisible();
  await expect(keys.getByText("Never used")).toBeVisible();

  // gone for good after a reload: only the prefix remains
  await page.reload();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByRole("list", { name: "API keys" }).getByText("CRM sync")).toBeVisible();

  await page.getByRole("list", { name: "API keys" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("list", { name: "API keys" }).getByText("Revoked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
});

test("results are announced in a live region; errors are alerts outside it", async ({ page }) => {
  await signup(page);
  await page.goto("/app/developers");
  const keyForm = page.locator("form").filter({ has: page.getByLabel("Key name") });
  const keyStatus = keyForm.getByRole("status");
  // the live region is in the page, empty, before anything is created
  await expect(keyStatus).toHaveCount(1);
  await expect(keyStatus).toHaveAttribute("aria-live", "polite");
  await expect(keyStatus).toBeEmpty();
  await expect(page.getByLabel("Key name")).toHaveAttribute("placeholder", "Key name, e.g. CRM sync");
  await page.getByLabel("Key name").fill("Live region test");
  await page.getByRole("button", { name: "Create API key" }).click();
  await expect(keyStatus).toContainText("Key created");
  // the key is shown, but never inside the live region (a screen reader would read it aloud)
  await expect(keyForm.locator("code", { hasText: /^cs_live_/ })).toBeVisible();
  await expect(keyStatus.locator("code")).toHaveCount(0);
  expect(await keyStatus.textContent()).not.toMatch(/cs_live_/);

  const hookForm = page.locator("form").filter({ has: page.getByLabel("Webhook URL") });
  await expect(hookForm.getByRole("status")).toBeEmpty();
  await page.getByLabel("Webhook URL").fill("https://user:pass@hooks.example.com/hook");
  await page.getByRole("button", { name: "Add webhook" }).click();
  const alert = hookForm.getByRole("alert");
  await expect(alert).toContainText("credentials");
  await expect(hookForm.getByRole("status").getByRole("alert")).toHaveCount(0);
  await expect(hookForm.getByRole("status")).toBeEmpty();
  expect(await alert.evaluate((el) => !!el.closest('[role="status"]'))).toBe(false);
});

test("add a webhook and see its delivery", async ({ page }) => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  await new Promise<void>((r) => srv.listen(0, "0.0.0.0", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    await signup(page);
    await uploadAndPublish(page, "01-simple-one-page.pdf");
    await page.goto("/app/developers");
    await expect(page.getByText("No webhooks yet")).toBeVisible();
    await expect(page.getByText("No deliveries yet")).toBeVisible();
    await page.getByLabel("Webhook URL").fill(`http://${process.env.WEBHOOK_HOST || "localhost"}:${port}/hook`);
    await page.getByLabel("file.created").check();
    await page.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.locator("code", { hasText: /^cswh_/ })).toBeVisible();
    expect(await page.getByRole("status").allTextContents()).not.toContainEqual(expect.stringMatching(/cswh_/));
    await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
    await expect(async () => {
      await page.goto("/app/developers");
      await expect(page.getByRole("list", { name: "Recent deliveries" }).getByText("delivered")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByRole("list", { name: "Webhook endpoints" })).toContainText("/hook");
  } finally {
    srv.close();
  }
});

test("staff can't open the page", async ({ page, browser }) => {
  await signup(page);
  await page.goto("/app/settings");
  await page.getByPlaceholder("colleague@example.com").fill(`staff-${uid()}@example.com`);
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const sc = await browser.newContext();
  const st = await sc.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app$/);
  await st.goto("/app/developers");
  await expect(st.getByRole("button", { name: "Create API key" })).toHaveCount(0);
  await expect(st.getByText("Integrations & API")).toHaveCount(0);
  await sc.close();
});

test("phone layout has no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signup(page);
  await page.goto("/app/developers");
  await expect(page.getByRole("heading", { name: "2. REST API" })).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
});
