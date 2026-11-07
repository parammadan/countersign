import { test, expect, type Page, type Browser } from "@playwright/test";
import { adoptCountersignature, publishDraft, uid } from "./helpers";
import { linkIn, smtpSink } from "./support/smtp-sink";

// Two people (or two tabs) pressing the same send button at the same moment must produce one email, not two.
// Real SMTP delivery to a local test server, with a delay on each message so the requests truly overlap.

const sink = smtpSink(2526, { dataDelayMs: 1500 });
test.beforeAll(() => sink.start());
test.afterAll(() => sink.stop());

async function session(browser: Browser, owner: string) {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3101" });
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel("Work email").fill(owner);
  await p.getByLabel("Password").fill("correct-horse-42");
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(p).toHaveURL(/\/app$/);
  return p;
}
const both = (a: Page, b: Page, name: string) => Promise.all([a.getByRole("button", { name }).click(), b.getByRole("button", { name }).click()]);

test("simultaneous sends from two sessions deliver one email per action", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const owner = `owner-${uid()}@example.com`;
  const client = `client-${uid()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Firm name").fill("Northwind Advisory");
  await page.getByLabel("Legal entity name").fill("Northwind Advisory, LLC");
  await page.getByLabel("Your name").fill("Avery Tester");
  await page.getByLabel("Work email").fill(owner);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect.poll(() => sink.find(owner, /Confirm your email/), { timeout: 20_000 }).toBeTruthy();
  await page.goto(linkIn(sink.find(owner, /Confirm your email/)!.raw, "confirm-email")!);
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page).toHaveURL(/confirmed=1/);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles("fixtures/agreements/02-msa-two-column.pdf");
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await publishDraft(page);
  await adoptCountersignature(page);
  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill("Jordan Sample");
  await page.getByLabel("Client email").fill(client);
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  const fileUrl = page.url().split("?")[0];
  await expect.poll(() => sink.count(client, /please review and sign/), { timeout: 20_000 }).toBe(1);

  const a = await session(browser, owner);
  const b = await session(browser, owner);
  for (const p of [a, b]) await p.goto(fileUrl);

  // two sessions press Send reminder at the same instant: exactly one reminder goes out
  await both(a, b, "Send reminder");
  await expect.poll(() => sink.count(client, /^Reminder:/), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(4000);
  expect(sink.count(client, /^Reminder:/), "simultaneous reminders").toBe(1);
  const msgs = [(await a.locator("[aria-live]").allInnerTexts()).join(" "), (await b.locator("[aria-live]").allInnerTexts()).join(" ")];
  expect(msgs.filter((m) => m.includes("Reminder sent.")), "one session is told it was sent").toHaveLength(1);
  expect(msgs.filter((m) => /is being sent right now|less than a minute ago/.test(m)), "the other is told why not").toHaveLength(1);

  // the same for Resend email
  for (const p of [a, b]) await p.goto(fileUrl);
  await both(a, b, "Resend email");
  await page.waitForTimeout(5000);
  expect(sink.count(client, /please review and sign/), "simultaneous resends").toBe(2); // the invitation + exactly one resend

  await a.context().close();
  await b.context().close();
});
