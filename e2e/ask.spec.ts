import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { signup } from "./helpers";

// M2.2 with AI answers OFF (this test server has no provider): answers are the quoted passages, with pages, or a
// clear "not found"; conversations and history are kept per version; other workspaces see nothing.
test("ask about an agreement without AI: quoted passages with pages, honest 'not found', isolation", async ({ page, browser }) => {
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
  await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
  const askUrl = page.url().split("?")[0];

  // an example question fills the box; asking shows the passages and their pages
  await page.getByRole("navigation", { name: "Example questions" }).getByRole("link", { name: "What are the payment terms?" }).click();
  await expect(page.getByLabel("Your question")).toHaveValue("What are the payment terms?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page).toHaveURL(/\?thread=qa_/);
  const turns = page.getByRole("list", { name: "Conversation" }).getByRole("article");
  await expect(turns).toHaveCount(1);
  const first = page.getByRole("article", { name: "Answer to: What are the payment terms?" });
  await expect(first).toContainText("Quoted passages, no AI");
  await expect(first.getByRole("region", { name: "Sources" }).locator("figure mark").first()).toBeVisible();
  await expect(first.locator("figure figcaption").first()).toHaveText(/^Page \d+$/);

  // a follow-up in the same conversation; a question the agreement doesn't address says so, with no quotes
  await page.getByLabel("Follow-up question").fill("What is the warranty period for the hardware?");
  await page.getByRole("button", { name: "Ask a follow-up" }).click();
  await expect(turns).toHaveCount(2);
  const second = page.getByRole("article", { name: "Answer to: What is the warranty period for the hardware?" });
  await expect(second).toContainText("Not found in the agreement");
  await expect(second.locator("figure")).toHaveCount(0);

  // a new conversation; the first one is listed
  await page.getByRole("link", { name: "Start a new conversation" }).click();
  await expect(page.getByRole("list", { name: "Earlier conversations" })).toContainText("What are the payment terms?");

  // a forged error in the URL shows only a fixed message; a forged thread id shows nothing
  await page.goto(`${askUrl}?error=${encodeURIComponent("Your account is suspended")}&thread=qa_doesnotexist`);
  await expect(page.getByText("Something went wrong. Try again.")).toBeVisible();
  await expect(page.getByText(/suspended/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();

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
