import { test, expect, type Browser, type Page } from "@playwright/test";
import { signup } from "./helpers";

const SHOTS = process.env.CLAUSES_SHOTS;

async function join(owner: Page, browser: Browser, role: "admin" | "staff", name: string) {
  await owner.goto("/app/settings");
  await owner.getByPlaceholder("colleague@example.com").fill(`${role}-${Math.random().toString(36).slice(2, 8)}@example.com`);
  await owner.getByLabel("Role for the new teammate").selectOption(role);
  await owner.getByRole("button", { name: "Invite" }).click();
  const invite = (await owner.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const p = await (await browser.newContext()).newPage();
  await p.goto(invite);
  await p.getByLabel("Your name").fill(name);
  await p.getByLabel("Choose a password").fill("correct-horse-42");
  await p.getByRole("button", { name: "Join workspace" }).click();
  await expect(p).toHaveURL(/\/app$/);
  return p;
}

test("Clause Library: create, submit, approve by a second admin; the author and staff cannot approve; other firms can't see it", async ({ page, browser }) => {
  await signup(page);
  const admin = await join(page, browser, "admin", "Robin Admin");
  const staff = await join(page, browser, "staff", "Sam Staff");

  // the nav shows the library under Intelligence
  await page.goto("/app");
  await page.getByRole("link", { name: "Clause Library" }).first().click();
  await expect(page.getByRole("heading", { name: "Clause Library" })).toBeVisible();
  await expect(page.getByText("No clauses yet")).toBeVisible();

  // the owner writes a draft with placeholders
  await page.getByLabel("Title").fill("Payment terms");
  await page.getByLabel("Kind").selectOption("payment");
  await page.getByLabel("Clause text").fill("{{client.name}} shall pay {{fee:money}} within {{days:int}} days of the invoice date.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/app\/clauses\/payment-terms-[a-z0-9]+\?ok=created$/);
  const url = page.url().replace(/\?.*$/, "");
  await expect(page.getByText("Draft created.")).toBeVisible();
  await expect(page.getByText("Placeholders: client.name (text), fee (money), days (int)")).toBeVisible();
  // preview with sample values
  await expect(page.getByText("Example Client LLC shall pay $1,500.00 within 30 days of the invoice date.")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-draft.png`, fullPage: true });

  // markup is refused, with the reason
  await page.goto("/app/clauses");
  await page.getByLabel("Title").fill("Bad clause");
  await page.getByLabel("Clause text").fill("See <b>this</b> term.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("The clause text isn't valid. It contains markup or an HTML tag.")).toBeVisible();
  // the URL carries codes only, never text
  expect(page.url()).toMatch(/\/app\/clauses\?error=invalid_body&issue=unsafe_html$/);

  // submit; the author cannot approve their own text
  await page.goto(url);
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted for approval.")).toBeVisible();
  await expect(page.getByText("You can't approve your own text.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // staff can read it but has no approve button
  await staff.goto(url);
  await expect(staff.getByRole("heading", { name: "Payment terms" })).toBeVisible();
  await expect(staff.getByText("Waiting for an owner or admin to approve it.")).toBeVisible();
  await expect(staff.getByRole("button", { name: "Approve" })).toHaveCount(0);

  // a second admin approves
  await admin.goto(url);
  await admin.getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByText("Approved. This version can now be used in agreements")).toBeVisible();
  await expect(admin.getByText("In use")).toBeVisible();
  await expect(admin.getByText("By Avery Tester · Firm template · approved by you", { exact: true })).toBeVisible();
  await admin.getByText("History (3)").click();
  await expect(admin.getByText(/In review → Approved by you/)).toBeVisible();
  if (SHOTS) await admin.screenshot({ path: `${SHOTS}/2-approved.png`, fullPage: true });

  // the owner sees who approved it
  await page.goto(url);
  await expect(page.getByText("By you · Firm template · approved by Robin Admin", { exact: true })).toBeVisible();

  // another firm cannot open it
  const other = await (await browser.newContext()).newPage();
  await signup(other, "Southfern Partners", "Southfern Partners, LLC");
  const res = await other.goto(url);
  expect(res?.status()).toBe(404);
  await other.goto("/app/clauses");
  await expect(other.getByText("No clauses yet")).toBeVisible();
});

test("Agreement Studio inserts an approved library clause rendered with the member's values", async ({ page, browser }) => {
  await signup(page);
  const admin = await join(page, browser, "admin", "Robin Admin");
  await page.goto("/app/clauses");
  await page.getByLabel("Title").fill("Late fees");
  await page.getByLabel("Clause text").fill("Invoices unpaid after {{days:int}} days carry a late fee of {{fee:money}}.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/app\/clauses\/late-fees-[a-z0-9]+\?ok=created$/);
  const url = page.url().replace(/\?.*$/, "");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText("Submitted for approval.")).toBeVisible();
  await admin.goto(url);
  await admin.getByRole("button", { name: "Approve" }).click();
  await expect(admin.getByText("In use")).toBeVisible();

  await page.goto("/app/studio");
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

  await page.getByRole("button", { name: "+ Add a clause after this one" }).first().click();
  await page.getByLabel("Insert an approved Clause Library clause").selectOption({ label: "Late fees (v1)" });
  await page.getByLabel("days").fill("45");
  await page.getByLabel("fee").fill("250");
  await page.getByRole("button", { name: "Use this clause" }).click();
  await expect(page.getByText("Approved clause filled in below.")).toBeVisible();
  await expect(page.getByPlaceholder("Clause text")).toHaveValue("Invoices unpaid after 45 days carry a late fee of $250.00.");
  await page.getByRole("button", { name: "Add clause" }).click();
  await expect(page.getByText("Clause added; later clauses and references were renumbered.")).toBeVisible();
  await expect(page.getByText("Invoices unpaid after 45 days carry a late fee of $250.00.")).toBeVisible();
});
