import { test, expect, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { adoptCountersignature, publishDraft, signAsClient, uid } from "./helpers";
import { linkIn, pdfAttachment, smtpSink } from "./support/smtp-sink";

// Email that really goes over SMTP (to a local test server that can refuse recipients with a 550):
// failed invitations and signed copies are shown as failures, recover through the file page, and a second
// click within a minute doesn't send a duplicate.

const sink = smtpSink(2526);
test.beforeAll(() => sink.start());
test.afterAll(() => sink.stop());

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
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

test("failed invitation and signed copy are shown honestly, recover from the file page, and aren't sent twice", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const owner = `owner-${uid()}@example.com`;
  const client = `client-${uid()}@example.com`;
  await signupConfirmed(page, owner);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles("fixtures/agreements/02-msa-two-column.pdf");
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await publishDraft(page);
  await adoptCountersignature(page);

  // the client's mailbox refuses mail: the invitation fails, and the page says so
  sink.refuse((to) => to === client);
  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill("Jordan Sample");
  await page.getByLabel("Client email").fill(client);
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  const fileUrl = page.url().split("?")[0];
  const fileId = fileUrl.split("/").pop()!;
  await expect(nextStep(page).getByRole("heading", { name: "The email to Jordan wasn't delivered" })).toBeVisible();
  await expect(nextStep(page)).toContainText("550 5.1.1 mailbox unavailable");
  await expect(page.getByRole("list", { name: "Audit trail" })).toContainText("Email to client failed");
  await expect(page.getByLabel("File details")).toContainText("Failed:");
  expect(sink.count(client, /please review and sign/)).toBe(0);

  // a reminder while it still refuses: reported as a failure, not "sent"
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText(/The email to .* couldn't be delivered/)).toBeVisible();
  await expect(page.getByText("Reminder sent.")).toHaveCount(0);

  // the mailbox recovers: Resend email delivers, and the page clears the failure
  sink.refuse(() => false);
  await page.getByRole("button", { name: "Resend email" }).click();
  await expect(page.getByText("Signing email sent again.")).toBeVisible();
  await expect.poll(() => sink.count(client, /please review and sign/)).toBe(1);
  await page.reload();
  await expect(nextStep(page).getByRole("heading", { name: "Waiting for Jordan to open the agreement" })).toBeVisible();
  await expect(page.getByLabel("File details")).toContainText("Sent (accepted by the mail server)");

  // a second Resend within a minute is refused and nothing more is sent
  await page.getByRole("button", { name: "Resend email" }).click();
  await expect(page.getByText("The signing email went to the client less than a minute ago, so it wasn't sent again.")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(sink.count(client, /please review and sign/)).toBe(1);
  // the same for reminders: one goes, the second is held back
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText("Reminder sent.")).toBeVisible();
  await expect.poll(() => sink.count(client, /^Reminder:/)).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText("A reminder went to the client less than a minute ago, so it wasn't sent again.")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(sink.count(client, /^Reminder:/)).toBe(1);

  // the client signs from the delivered email, but their mailbox refuses the signed copy
  const link = linkIn(sink.find(client, /please review and sign/)!.raw, "s")!;
  sink.refuse((to) => to === client);
  const ctx = await browser.newContext();
  await signAsClient(ctx, link);
  await ctx.close();
  await page.goto(fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Ready for work, but the client's copy wasn't emailed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed agreement" })).toBeVisible();
  await expect(page.getByText(/The email with the signed copy failed \(.*550/)).toBeVisible();
  const resend = page.getByRole("button", { name: "Resend signed copy" });
  await expect(resend).toBeVisible();

  // still refusing: the resend fails, is reported, and the copy is not marked as emailed
  await resend.click();
  await expect(page.getByText(/The signed copy couldn't be emailed/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resend signed copy" })).toBeVisible();

  // recovered: the resend delivers the stored PDF byte for byte, and the button goes away
  sink.refuse(() => false);
  await page.getByRole("button", { name: "Resend signed copy" }).click();
  await expect(page.getByText(`Signed copy emailed to ${client}.`)).toBeVisible();
  await expect.poll(() => sink.count(client, /^Signed: your/)).toBe(1);
  const att = pdfAttachment(sink.find(client, /^Signed: your/)!.raw)!;
  const stored = await page.request.get(`/api/files/${fileId}/document`).then((r) => r.body());
  expect(att.subarray(0, 5).toString()).toBe("%PDF-");
  expect(sha(att)).toBe(sha(stored));
  await page.reload();
  await expect(nextStep(page).getByRole("heading", { name: "Ready for work", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend signed copy" })).toHaveCount(0);
  await expect(page.getByText(new RegExp(`Emailed to ${client.replace(/[.+]/g, "\\$&")} on`))).toBeVisible();
  await expect(page.getByRole("list", { name: "Readiness checks" })).toContainText("Passed: Client emailed their signed copy");
  await expect(page.getByRole("list", { name: "Audit trail" })).toContainText("Signed copy emailed again");
  await expect(page.getByText(sha(stored))).toBeVisible(); // the fingerprint shown is the stored file's

  // the emailed copy verifies
  await page.goto("/verify");
  await page.locator('input[type="file"]').setInputFiles({ name: "copy.pdf", mimeType: "application/pdf", buffer: att });
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Authentic.")).toBeVisible();
});
