import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { signup } from "./helpers";

// M2.1: an admin uploads an agreement, has it read, sees what it says with the text each point is based on,
// and confirms or dismisses each suggestion. Another workspace can't see any of it.

test("read an uploaded agreement, see quoted findings, confirm and dismiss them", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  const agreementUrl = page.url().split("?")[0];

  await page.getByRole("link", { name: "What it says" }).click();
  await expect(page.getByRole("heading", { name: "What this agreement says", level: 1 })).toBeVisible();
  await expect(page.getByText("Not read yet")).toBeVisible();
  await expect(page.getByText(/not legal advice/)).toBeVisible();
  await page.getByRole("button", { name: "Read this agreement" }).click();
  await expect(page).toHaveURL(/\/understand\?read=1$/);
  const understandUrl = page.url().split("?")[0];

  // grouped findings, each with a status in words and the quoted text it rests on
  for (const h of ["Parties", "Agreement type and purpose", "Dates and term", "Payment terms", "Signature requirements"]) await expect(page.getByRole("heading", { name: h, level: 2 })).toBeVisible();
  await expect(page.getByText(/built-in reading rules \(no AI model/)).toBeVisible();
  await expect(page.getByText("Stated in the document").first()).toBeVisible();
  await expect(page.locator("figure blockquote").first()).toBeVisible();
  await expect(page.locator("figure figcaption").first()).toHaveText(/^Page \d+$/);
  await expect(page.getByText("Nothing confirmed yet.")).toBeVisible();

  // confirm one: it moves into "Confirmed by your team"; dismiss another; undo
  const types = page.getByRole("list", { name: "Agreement type and purpose" }).getByRole("listitem");
  const first = types.first();
  const label = (await first.locator("span.font-medium").first().innerText()).trim();
  await first.getByRole("button", { name: `Confirm: ${label}` }).click();
  await expect(page.getByRole("list", { name: "Confirmed facts" })).toContainText(label);
  await expect(page.getByRole("list", { name: "Agreement type and purpose" }).getByText(/^Confirmed by /).first()).toBeVisible();
  const pay = page.getByRole("list", { name: "Payment terms" }).getByRole("listitem").first();
  const payLabel = (await pay.locator("span.font-medium").first().innerText()).trim();
  await pay.getByRole("button", { name: `Dismiss: ${payLabel}` }).click();
  await expect(page.getByRole("list", { name: "Payment terms" }).getByText(/^Dismissed by /)).toBeVisible();
  await page.getByRole("list", { name: "Payment terms" }).getByRole("button", { name: `Undo: ${payLabel}` }).click();
  await expect(page.getByRole("list", { name: "Payment terms" }).getByText(/^Dismissed by /)).toHaveCount(0);

  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect.soft(r.violations.map((v) => `${v.id}: ${v.nodes.length}x ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);

  // reading it again starts a fresh set of suggestions
  await page.getByRole("button", { name: "Read again" }).click();
  await expect(page.getByText("Nothing confirmed yet.")).toBeVisible();

  // the agreement itself is untouched: still a draft with its fields
  await page.goto(agreementUrl);
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // another workspace gets a 404, for the page and the agreement
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signup(other, "Southwind Partners", "Southwind Partners, LLC");
  expect((await other.goto(understandUrl))!.status()).toBe(404);
  expect(await other.content()).not.toContain(label === "Agreement type" ? "Engagement letter" : label);
  await ctx.close();
});

test("staff can read the findings but not run or review them; error text never comes from the URL", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(path.join(process.cwd(), "fixtures/agreements/02-msa-two-column.pdf"));
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  const understandUrl = page.url().split("?")[0] + "/understand";
  await page.goto(understandUrl);
  await page.getByRole("button", { name: "Read this agreement" }).click();
  await expect(page.getByRole("heading", { name: "Parties", level: 2 })).toBeVisible();

  // a forged error in the URL shows only our own generic message
  await page.goto(`${understandUrl}?error=${encodeURIComponent("Your account is suspended, call 555-0100")}`);
  await expect(page.getByText("Something went wrong. Try again.")).toBeVisible();
  await expect(page.getByText(/suspended/)).toHaveCount(0);
  await page.goto(`${understandUrl}?error=__proto__`);
  await expect(page.getByText("Something went wrong. Try again.")).toBeVisible();

  // a staff teammate
  await page.goto("/app/settings");
  const email = `staff-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.getByPlaceholder("colleague@example.com").fill(email);
  await page.getByLabel("Role for the new teammate").selectOption("staff");
  await page.getByRole("button", { name: "Invite" }).click();
  const code = page.locator("code", { hasText: "/invite/" }).first();
  await expect(code).toBeVisible();
  const invite = (await code.textContent())!.trim();
  const ctx = await browser.newContext();
  const st = await ctx.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app/);

  await st.goto(understandUrl);
  await expect(st.getByRole("heading", { name: "Parties", level: 2 })).toBeVisible();
  await expect(st.locator("figure blockquote").first()).toBeVisible();
  await expect(st.getByRole("button", { name: /^(Read again|Read this agreement)$/ })).toHaveCount(0);
  await expect(st.getByRole("button", { name: /^(Confirm|Dismiss|Undo):/ })).toHaveCount(0);
  await ctx.close();
});
