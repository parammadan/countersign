import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { adoptCountersignature, signAsClient, uid, uploadAndPublish } from "./helpers";
import { bodyText, linkIn, pdfAttachment, smtpSink } from "./support/smtp-sink";

// The whole path with emailed codes switched on, over real SMTP: the invitation is delivered, the client opens
// it from the email, nothing about the agreement is shown until the emailed code is entered (a wrong code is
// refused and recorded, a forwarded link without the code gets nothing), the client signs, the firm
// countersigns by hand, the client's emailed copy verifies, and the file is ready for work.

const sink = smtpSink(2526);
test.beforeAll(() => sink.start());
test.afterAll(() => sink.stop());

const nextStep = (page: Page) => page.getByRole("region", { name: /.+/ }).filter({ hasText: "Next step" });

async function signupConfirmed(page: Page, owner: string) {
  await page.goto("/signup");
  await page.getByLabel("Firm name").fill("Northwind Advisory");
  await page.getByLabel("Legal entity name").fill("Northwind Advisory, LLC");
  await page.getByLabel("Your name").fill("Avery Tester");
  await page.getByLabel("Work email").fill(owner);
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect.poll(() => sink.find(owner, /Confirm your email/)).toBeTruthy();
  await page.goto(linkIn(sink.find(owner, /Confirm your email/)!.raw, "confirm-email")!);
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page).toHaveURL(/confirmed=1/);
}

const codeIn = (raw: string) => bodyText(raw).match(/>(\d{6})<\/span>/)?.[1];

test("emailed codes on: invitation, code, signing, manual countersign, verified copy, ready for work", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const owner = `owner-${uid()}@example.com`;
  const client = `client-${uid()}@example.com`;
  await signupConfirmed(page, owner);
  await uploadAndPublish(page, "05-drawn-lines-label-under.pdf");
  await adoptCountersignature(page);
  await page.goto("/app/settings");
  await page.locator('input[name="require_otp"]').check();
  await page.locator('input[name="auto_countersign"]').uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill("Jordan Sample");
  await page.getByLabel("Client email").fill(client);
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  const fileUrl = page.url().split("?")[0];
  await expect.poll(() => sink.count(client, /please review and sign/)).toBe(1);
  const link = linkIn(sink.find(client, /please review and sign/)!.raw, "s")!;

  // the client opens the emailed link: only the code step, nothing about the agreement
  const ctx = await browser.newContext();
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.231" });
  const c = await ctx.newPage();
  await c.goto(link);
  await expect(c.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(c.getByText(/cl\*\*\*@example\.com/)).toBeVisible();
  await expect(c.getByText(client)).toHaveCount(0);
  await expect(c.locator("[data-fid]")).toHaveCount(0);
  const api = link.replace("/s/", "/api/sign/");
  expect((await c.request.get(`${api}/pdf`)).status(), "no PDF before the code").toBe(403);
  await new AxeBuilder({ page: c }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze().then((r) => expect.soft(r.violations.map((v) => v.id)).toEqual([]));

  await c.getByRole("button", { name: "Email me a code" }).click();
  await expect(c.getByText(/Code sent to cl\*\*\*@example\.com\. It expires in 10 minutes\./)).toBeVisible();
  const input = c.getByLabel("6-digit code");
  await expect(input).toBeFocused();
  await expect(c.getByRole("button", { name: /Send a new code in \d+s/ })).toBeDisabled();
  await expect.poll(() => sink.find(client, /is your verification code/)).toBeTruthy();
  const code = codeIn(sink.find(client, /is your verification code/)!.raw)!;
  expect(code).toMatch(/^\d{6}$/);

  // a wrong code is refused, says so, and is recorded
  const wrong = code === "111111" ? "222222" : "111111";
  await input.fill(wrong);
  await c.getByRole("button", { name: "Verify" }).click();
  await expect(c.getByRole("alert").filter({ hasText: "That code isn't right" })).toBeVisible();
  await expect(input).toHaveAttribute("aria-invalid", "true");

  // a forwarded link in another browser still gets nothing, even after the right code is used here
  const other = await browser.newContext();
  await other.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.232" });
  const o = await other.newPage();

  // the right code, pasted with a space as people copy it from the email
  await input.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await expect(input).toHaveValue(code);
  await c.getByRole("button", { name: "Verify" }).click();
  await expect(c.getByRole("button", { name: "Review and sign" })).toBeVisible();
  await expect(c.getByText(/Hi Jordan/)).toBeVisible();

  await o.goto(link);
  await expect(o.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  expect((await o.request.post(`${api}/complete`, { data: { consent: true, values: {}, method: "typed" } })).status()).toBe(403);
  await other.close();

  // the code can't be replayed
  expect((await c.request.post(`${api}/verify`, { data: { code } })).status()).toBe(400);

  // sign: the firm countersigns by hand, so the client is told that comes next
  await signAsClient(ctx, link);
  const done = ctx.pages().at(-1)!;
  await expect(done.getByText(/countersigns next/)).toBeVisible();
  await expect(done.getByRole("link", { name: "Download signed copy" })).toHaveCount(0);
  await ctx.close();

  await page.goto(fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Your countersignature is needed" })).toBeVisible();
  const trail = page.getByRole("list", { name: "Audit trail" });
  for (const e of ["Verification code emailed", "Wrong verification code entered", "Client verified their email code"]) await expect(trail).toContainText(e);
  await page.getByRole("button", { name: "Countersign and complete" }).click();
  await expect(nextStep(page).getByRole("heading", { name: "Ready for work", exact: true })).toBeVisible();

  // the client's emailed copy is the sealed agreement and verifies
  await expect.poll(() => sink.count(client, /^Signed: your/)).toBe(1);
  const att = pdfAttachment(sink.find(client, /^Signed: your/)!.raw)!;
  expect(att.subarray(0, 5).toString()).toBe("%PDF-");
  await page.goto("/verify");
  await page.locator('input[type="file"]').setInputFiles({ name: "copy.pdf", mimeType: "application/pdf", buffer: att });
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Authentic.")).toBeVisible();
});
