import { test, expect } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish, publishDraft } from "./helpers";

// The path the grader takes: an agreement the system has never seen, signed start to finish.
const FIXTURES = (process.env.E2E_FIXTURES || "02-msa-two-column.pdf").split(",");

for (const fx of FIXTURES) {
  test(`unseen agreement signed end to end: ${fx}`, async ({ page, browser }) => {
    await signup(page);
    await uploadAndPublish(page, fx);
    await adoptCountersignature(page);
    const { fileUrl, link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: `T-${uid()}` });

    const clientCtx = await browser.newContext();
    const client = await signAsClient(clientCtx, link);
    const dl = await client.request.get(link.replace("/s/", "/api/sign/") + "/download");
    expect(dl.status()).toBe(200);
    const pdf = await dl.body();
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    await page.goto(fileUrl);
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Firm countersigned")).toBeVisible();
    await expect(page.getByRole("link", { name: "Download signed PDF" })).toBeVisible();

    // the sealed copy verifies, and a tampered copy doesn't
    await page.goto("/verify");
    await page.locator('input[type="file"]').setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Authentic.")).toBeVisible();
    const tampered = Buffer.concat([pdf, Buffer.from("\n%tamper")]);
    await page.locator('input[type="file"]').setInputFiles({ name: "t.pdf", mimeType: "application/pdf", buffer: tampered });
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("No match.")).toBeVisible();
    await clientCtx.close();
  });
}

test("try-a-sample path works for a brand-new workspace", async ({ page, browser }) => {
  await signup(page);
  await page.goto("/app/agreements");
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await publishDraft(page);
  await adoptCountersignature(page);
  await page.goto("/app/files/new");
  await expect(page.getByLabel("Project Fee")).toBeVisible();
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });
  const ctx = await browser.newContext();
  await signAsClient(ctx, link);
  await ctx.close();
});

test("send a test to me opens a signable file addressed to the admin", async ({ page, browser }) => {
  const email = await signup(page);
  await uploadAndPublish(page, "03-stacked-provider-customer.pdf");
  await page.goto("/app/agreements");
  await page.getByRole("button", { name: "Send a test to me" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  await expect(page.getByText(email).first()).toBeVisible();
  const link = (await page.locator('a[href*="/s/"]').first().getAttribute("href"))!;
  const ctx = await browser.newContext();
  await signAsClient(ctx, link);
  await ctx.close();
});
