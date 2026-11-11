import { test, expect, devices, type Page } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// The Overview against real actions: every number and item comes from what the test did, each item links
// to its file, staff see what they may act on, and another workspace sees none of it.

const stat = (page: Page, label: string) => page.getByRole("link", { name: new RegExp(`^${label}`) });
const attention = (page: Page) => page.locator("#attention");

test("overview follows the real workflow: setup, attention, countersign, ready for work", async ({ page, browser }) => {
  await signup(page, "Northwind Advisory", "Northwind Advisory, LLC");

  // brand new: "Start here" links to the real screens
  const start = page.getByRole("list", { name: "Start here" });
  await expect(start.getByRole("link")).toHaveText(["Try a sample agreement", "Fill details with AI", "Upload an agreement", "Ask the Knowledge Hub"]);
  await start.getByRole("link", { name: "Try a sample agreement" }).click();
  await expect(page.getByRole("button", { name: "Try a sample agreement" })).toBeVisible();
  await page.goto("/app");

  // brand new: the next step is the first setup step, nothing is counted
  const next = page.getByRole("region", { name: "Upload your client agreement" });
  await expect(next).toBeVisible();
  await expect(page.getByText("0 of 4 done")).toBeVisible();
  for (const l of ["Needs attention", "Awaiting signature", "Ready for work", "Live agreements"]) await expect(stat(page, l)).toContainText("0");
  await expect(attention(page).getByText("Nothing needs attention")).toBeVisible();
  await next.getByRole("link", { name: "Upload agreement" }).click();
  await expect(page).toHaveURL(/\/app\/agreements$/);

  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await page.goto("/app");
  await expect(page.getByRole("list", { name: "Start here" })).toHaveCount(0); // not new any more
  await expect(page.getByRole("list").filter({ hasText: "Agreement published" })).toContainText("Agreement uploaded");
  await expect(page.getByRole("region", { name: "Adopt your firm's countersignature" })).toBeVisible();
  await expect(stat(page, "Live agreements")).toContainText("1");
  await adoptCountersignature(page);

  // review countersignatures by hand so one can wait on the firm
  await page.goto("/app/settings");
  await page.locator('input[name="auto_countersign"]').uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  const a = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com`, ref: `OV-${uid()}` });
  const b = await newFile(page, { name: "Casey Placeholder", email: `client-${uid()}@example.com`, ref: `OV-${uid()}` });
  await page.goto("/app");
  await expect(stat(page, "Awaiting signature")).toContainText("2");
  await expect(page.getByRole("region", { name: "Everything is on track" })).toBeVisible();

  // client B declines: it becomes the top item and the next step
  const cb = await browser.newContext();
  const bp = await cb.newPage();
  await bp.goto(b.link);
  await bp.getByRole("button", { name: "I don't want to sign this" }).click();
  await bp.getByRole("dialog").locator("textarea").fill("Synthetic test: wrong scope");
  await bp.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
  await expect(bp.getByRole("dialog").getByRole("heading", { name: "Declined" })).toBeVisible();
  await cb.close();

  // client A signs: with auto-countersign off it waits on the firm, which outranks the decline
  const ca = await browser.newContext();
  await signAsClient(ca, a.link);
  await ca.close();

  await page.goto("/app");
  await expect(stat(page, "Needs attention")).toContainText("2");
  const items = attention(page).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Riley Example");
  await expect(items.nth(0)).toContainText("Waiting for your countersignature");
  await expect(items.nth(1)).toContainText("Casey Placeholder");
  await expect(items.nth(1)).toContainText("Client declined");
  await expect(page.getByRole("region", { name: "Waiting for your countersignature: Riley Example" })).toBeVisible();

  // recent activity is the real audit trail
  const activity = page.getByRole("list").filter({ hasText: "Client signed" }).first();
  await expect(activity).toContainText("Client declined");

  // the item opens its file, where the action really exists
  await items.nth(0).getByRole("link", { name: "Riley Example" }).click();
  await expect(page).toHaveURL(new RegExp(new URL(a.fileUrl).pathname));
  await page.getByRole("button", { name: "Countersign and complete" }).click();
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();

  await page.goto("/app");
  await expect(stat(page, "Ready for work")).toContainText("1");
  await expect(stat(page, "Needs attention")).toContainText("1");
  await expect(stat(page, "Awaiting signature")).toContainText("0");
  await stat(page, "Ready for work").click();
  await expect(page).toHaveURL(/status=completed/);
  await expect(page.getByRole("link", { name: /Riley Example/ })).toBeVisible();

  // staff: same numbers, no admin links, and the admin-only action says so
  await page.goto("/app/settings");
  const staffEmail = `staff-${uid()}@example.com`;
  await page.getByPlaceholder("colleague@example.com").fill(staffEmail);
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const cs = await browser.newContext();
  const st = await cs.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app$/);
  await expect(stat(st, "Ready for work")).toContainText("1");
  await expect(stat(st, "Needs attention")).toContainText("1");
  const nav = st.getByRole("navigation", { name: "Workspace" });
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Integrations & API" })).toHaveCount(0);
  await cs.close();

  // another workspace sees none of it
  const other = await browser.newContext();
  const o = await other.newPage();
  await signup(o, "Fakewell Partners", "Fakewell Partners LLP");
  for (const l of ["Needs attention", "Awaiting signature", "Ready for work", "Live agreements"]) await expect(stat(o, l)).toContainText("0");
  await expect(o.getByText("Riley Example")).toHaveCount(0);
  await expect(o.getByText("Casey Placeholder")).toHaveCount(0);
  await other.close();
});

test("overview fits a phone and a tablet without sideways scrolling", async ({ browser }) => {
  for (const device of ["Pixel 7", "iPad Mini"] as const) {
    const ctx = await browser.newContext({ ...devices[device] });
    const page = await ctx.newPage();
    await signup(page);
    await uploadAndPublish(page, "02-msa-two-column.pdf");
    await adoptCountersignature(page);
    await newFile(page, { name: "Jordan Sample with a fairly long name", email: `a-very-long-client-address-${uid()}@example.com`, ref: `PH-${uid()}` });
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Recent files" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${device}: page scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    await page.goto("/app/files");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${device}: files list`).toBeLessThanOrEqual(0);
    await ctx.close();
  }
});
