import { test, expect } from "@playwright/test";
import { signup } from "./helpers";

const SHOTS = process.env.STUDIO_SHOTS;

test("Agreement Studio: generate a services agreement, edit a clause, version history, export", async ({ page }) => {
  await signup(page);
  await page.goto("/app/studio");
  await expect(page.getByRole("heading", { name: "Agreement Studio" })).toBeVisible();
  await expect(page.getByText("AI off: templates only")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-studio.png`, fullPage: true });

  await page.getByLabel("Type of agreement").selectOption("services");
  await page.getByLabel("Provider (legal name)").fill("Northwind Advisory LLC");
  await page.getByLabel("Client (legal name)").fill("Acme Widgets Inc");
  await page.getByLabel("Fee (with currency, e.g. $5,000)").fill("$12,000");
  await page.getByLabel("Payment due (days after invoice)").fill("30");
  await page.getByLabel("Start date").fill("2027-01-15");
  await page.getByLabel("Notice period (days)").fill("30");
  await page.getByLabel("Governing law (state or country)").fill("Delaware");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page).toHaveURL(/\/app\/studio\/drf_/, { timeout: 30_000 });
  await expect(page.getByText("Drafted from the template with exactly the values you gave.")).toBeVisible();
  await expect(page.getByText("$12,000").first()).toBeVisible();
  await expect(page.getByText("Draft · v1")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-draft.png`, fullPage: true });

  // edit an unlocked clause: a new version is saved
  await page.getByRole("button", { name: "Edit" }).nth(1).click();
  const box = page.locator("textarea").first();
  await box.fill((await box.inputValue()) + " Each party will keep a copy of this Agreement.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved as a new version.")).toBeVisible();
  await expect(page.getByText("Draft · v2")).toBeVisible();
  await expect(page.getByText("Each party will keep a copy of this Agreement.")).toBeVisible();

  // the locked signature clause offers no edit
  await expect(page.getByText("Locked").first()).toBeVisible();

  // export
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.pdf$/);
  const dl2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "DOCX" }).click();
  expect((await dl2).suggestedFilename()).toMatch(/\.docx$/);

  // submit; the owner edited it, so they can't approve it
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Waiting for approval · v2")).toBeVisible();
  await expect(page.getByText("You edited this draft, so someone else must approve it.")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-submitted.png`, fullPage: true });
});

test("Agreement Studio: a second admin approves, the owner publishes it to Agreements for signing; staff cannot approve", async ({ page, browser }) => {
  await signup(page);
  // invite an admin and a staff member
  const join = async (role: "admin" | "staff", name: string) => {
    await page.goto("/app/settings");
    await page.getByPlaceholder("colleague@example.com").fill(`${role}-${Math.random().toString(36).slice(2, 8)}@example.com`);
    await page.getByLabel("Role for the new teammate").selectOption(role);
    await page.getByRole("button", { name: "Invite" }).click();
    const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(invite);
    await p.getByLabel("Your name").fill(name);
    await p.getByLabel("Choose a password").fill("correct-horse-42");
    await p.getByRole("button", { name: "Join workspace" }).click();
    await expect(p).toHaveURL(/\/app$/);
    return p;
  };
  const admin = await join("admin", "Robin Admin");
  const staff = await join("staff", "Sam Staff");

  await page.goto("/app/studio");
  await page.getByLabel("Type of agreement").selectOption("nda");
  await page.getByLabel("Disclosing Party (legal name)").fill("Northwind Advisory LLC");
  await page.getByLabel("Receiving Party (legal name)").fill("Acme Widgets Inc");
  await page.getByLabel("Start date").fill("2027-02-01");
  await page.getByLabel("Confidentiality lasts (years)").fill("3");
  await page.getByLabel("Governing law (state or country)").fill("Delaware");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page).toHaveURL(/\/app\/studio\/drf_/, { timeout: 30_000 });
  const url = page.url();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Waiting for approval · v1")).toBeVisible();

  // staff: no approve button
  await staff.goto(url);
  await expect(staff.getByText("Waiting for an owner or admin to approve.")).toBeVisible();
  await expect(staff.getByRole("button", { name: /^Approve/ })).toHaveCount(0);

  // admin approves
  await admin.goto(url);
  await admin.getByRole("button", { name: "Approve v1" }).click();
  await expect(admin.getByText("Approved · v1")).toBeVisible();

  // owner publishes; it becomes an agreement draft in the existing library, ready for fields and sending
  await page.reload();
  await page.getByRole("button", { name: "Publish to Agreements" }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-published-agreement.png`, fullPage: true });
  await page.goto(url);
  await expect(page.getByText("Published · v1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open it in Agreements" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-published-draft.png`, fullPage: true });
});
