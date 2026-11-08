import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { signup } from "./helpers";

// M2.2: ask a question about an uploaded agreement and get an answer tied to quoted passages and pages, or a clear
// "not found". The test server has no AI provider configured, so answers are the quoted passages (no model).

test("ask about an agreement: quoted answers with pages, honest 'not found', isolation", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  const agreementUrl = page.url().split("?")[0];

  await page.goto(`${agreementUrl}/understand`);
  await page.getByRole("link", { name: "Ask a question" }).click();
  await expect(page.getByRole("heading", { name: "Ask about this agreement", level: 1 })).toBeVisible();
  await expect(page.getByText(/AI answers are off on this server/)).toBeVisible();
  await expect(page.getByText("No questions yet.")).toBeVisible();
  const askUrl = page.url().split("?")[0];

  // an example question fills the box; asking shows an answer with quoted passages and their pages
  await page.getByRole("navigation", { name: "Example questions" }).getByRole("link", { name: "What are the payment terms?" }).click();
  await expect(page.getByLabel("Your question")).toHaveValue("What are the payment terms?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page).toHaveURL(/\?asked=qa_/);
  const answers = page.getByRole("list", { name: "Answers" }).getByRole("listitem");
  await expect(answers).toHaveCount(1);
  const first = answers.first();
  await expect(first).toContainText("What are the payment terms?");
  await expect(first).toContainText("Passages, no AI model");
  await expect(first.locator("figure blockquote").first()).toBeVisible();
  await expect(first.locator("figure figcaption").first()).toHaveText(/^Page \d+$/);

  // a question the agreement doesn't address says so, with no quotes
  await page.getByLabel("Your question").fill("What is the warranty period for the hardware?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(answers).toHaveCount(2);
  await expect(answers.first()).toContainText("Not found in the agreement");
  await expect(answers.first().locator("figure")).toHaveCount(0);

  // a forged error in the URL shows only a fixed message
  await page.goto(`${askUrl}?error=${encodeURIComponent("Your account is suspended")}`);
  await expect(page.getByText("Something went wrong. Try again.")).toBeVisible();
  await expect(page.getByText(/suspended/)).toHaveCount(0);

  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect.soft(r.violations.map((v) => `${v.id}: ${v.nodes.length}x ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);

  // another workspace gets a 404 and none of the questions
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await signup(other, "Southwind Partners", "Southwind Partners, LLC");
  expect((await other.goto(askUrl))!.status()).toBe(404);
  expect(await other.content()).not.toContain("warranty period");
  await ctx.close();
});
