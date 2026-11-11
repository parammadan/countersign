import { test, expect, type Page } from "@playwright/test";
import { signup } from "./helpers";
import { startMockAnthropic, type Script } from "./support/mock-anthropic";

// Agreement Studio with AI ON, against the local mock of the Anthropic API (no network, no cost; "ai" project).
// The mock's suggestion is a response real Claude gave for this description (captured 2026-11-11). Regression for
// "I filled in the details but it still says they're missing": typed numbers ("30 days") used to vanish from
// <input type="number"> and be sent as missing; an error now clears as soon as its field is edited.
const DESC = "I need a services agreement: Harbor Digital LLC will build a mobile app for Bluefin Foods Inc. Flat fee $24,000, half up front and half on delivery, payment due net 15. Start date 2027-02-01. Governed by New York law.";
const REAL_SUGGESTION = {
  kind: "services",
  parties: [{ role: "Provider", name: "Harbor Digital LLC" }, { role: "Client", name: "Bluefin Foods Inc." }],
  terms: [{ key: "fee", value: "$24,000" }, { key: "feeBasis", value: "fixed" }, { key: "paymentDays", value: "15" }, { key: "startDate", value: "2027-02-01" }, { key: "governingLaw", value: "New York" }],
  clarifications: [
    { key: "noticeDays", status: "missing", note: "" }, { key: "endDate", status: "missing", note: "" },
    { key: "other", status: "not_supported", note: "The template cannot split the flat fee into half paid up front and half paid on delivery." },
  ],
};
// the suggestion call gets the captured answer; anything else (the optional AI wording at Generate) fails, so the
// draft is the plain template
const script: Script = (_q, _ps, seen) => (/fill in the form for one of the reviewed templates/.test(seen.system) ? { answer: REAL_SUGGESTION } : { status: 500 });

const needed = (page: Page) => page.getByRole("region", { name: "Needed before you can generate" });
const errorList = (page: Page) => page.locator("ul.list-disc");

async function expectDraftSaved(page: Page, who: string) {
  await expect(page).toHaveURL(/\/app\/studio\/[^/?]+/, { timeout: 60_000 });
  const url = page.url();
  await page.reload();
  await expect(page.getByText(who).first()).toBeVisible();
  await page.goto("/app/studio");
  await expect(page.locator(`a[href^="${new URL(url).pathname}"]`).first()).toBeVisible();
}

test("Studio with AI: Claude fills the form, a needed field typed as '30 days' clears at once, the draft is saved", async ({ page }) => {
  test.setTimeout(180_000);
  const mock = await startMockAnthropic(script);
  try {
    await signup(page);
    await page.goto("/app/studio");
    await page.getByLabel("Tell AI what you need").fill(DESC);
    await page.getByRole("button", { name: "Fill details with AI", exact: true }).click();
    await expect(page.getByText(/Claude suggested \d+ details/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel("Type of agreement")).toHaveValue("services");
    await expect(page.getByLabel("Provider (legal name)")).toHaveValue("Harbor Digital LLC");
    await expect(page.getByLabel("Client (legal name)")).toHaveValue("Bluefin Foods Inc.");
    await expect(page.getByLabel(/^Fee/)).toHaveValue("$24,000");
    await expect(page.getByLabel(/^Payment due/)).toHaveValue("15");
    await expect(page.getByLabel(/^How the fee is charged/)).toHaveValue("fixed");
    // the description gives no notice period: it is needed, and typing it in (with its unit) clears that at once
    await expect(needed(page)).toContainText("Notice period");
    await page.getByLabel(/^Notice period/).pressSequentially("30 days");
    await expect(page.getByLabel(/^Notice period/)).toHaveValue("30 days");
    await expect(needed(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Generate draft" }).click();
    // what the template can't include is shown again on the draft, for review and approval
    await expect(page).toHaveURL(/\/app\/studio\/[^/?]+/, { timeout: 60_000 });
    await expect(page.getByText(/^Not in this draft/)).toBeVisible();
    await expect(page.getByText(/split the flat fee into half paid up front/)).toBeVisible();
    await expectDraftSaved(page, "Bluefin Foods Inc.");
  } finally {
    await mock.close();
  }
});

test("Studio by hand: an unreadable number is named, clears when edited, then the draft is saved", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page);
  await page.goto("/app/studio");
  await page.getByLabel("Type of agreement").selectOption("services");
  await page.getByLabel("Provider (legal name)").pressSequentially("Northwind Advisory LLC");
  await page.getByLabel("Client (legal name)").pressSequentially("Acme Widgets Inc");
  await page.getByLabel(/^Fee/).pressSequentially("15,000 USD");
  await page.getByLabel(/^Payment due/).pressSequentially("net 30");
  await page.getByLabel(/^Start date/).fill("2027-01-15");
  await page.getByLabel(/^Notice period/).pressSequentially("30 days");
  await page.getByLabel(/^Governing law/).pressSequentially("Delaware");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(errorList(page)).toContainText("Payment due (days after invoice): enter a whole number of days, like 30.");
  await expect(page).toHaveURL(/\/app\/studio$/);
  // editing that field clears what was said about it, before Generate is pressed again
  await page.getByLabel(/^Payment due/).fill("30 days");
  await expect(errorList(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expectDraftSaved(page, "Acme Widgets Inc");
});
