import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { publishDraft, signup } from "./helpers";

// REAL Claude, end to end in the browser: M2.2 Q&A, M2.3 Studio (fill-in from a description, AI wording, edit,
// second-admin approval, publish, export) and the M3 Knowledge Hub. Paid: runs only with REAL_AI_E2E=1 against a
// server the operator started with a real key and a spending limit (E2E_BASE_URL). Records every outcome to
// REAL_AI_OUT. Never part of CI.
test.skip(process.env.REAL_AI_E2E !== "1", "real-AI run only (paid; owner-approved budget)");

const OUT = process.env.REAL_AI_OUT ?? "real-ai-results.json";
const SHOTS = process.env.REAL_AI_SHOTS;
const results: Record<string, unknown> = {};
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

/** Local disposable data only: mark the owner's address confirmed (the operator's server has no mailbox). */
function confirmEmail(email: string) {
  const file = process.env.REAL_AI_DB;
  if (!file) throw new Error("REAL_AI_DB must point at the local test server's database");
  const db = new DatabaseSync(file);
  db.prepare("UPDATE users SET email_verified_at = ? WHERE email = ?").run(new Date().toISOString(), email.toLowerCase());
  db.close();
}

test.describe.configure({ mode: "serial" });

test("real Claude: Q&A, Studio and Knowledge Hub in the browser", async ({ page, browser }) => {
  test.setTimeout(900_000);
  const email = await signup(page, "Northwind Advisory", "Northwind Advisory LLC");
  confirmEmail(email);

  // ---------- M2.2: ask about one agreement ----------
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  const agreementUrl = page.url().split("?")[0];
  await expect(page.getByText("found automatically")).toBeVisible();
  await publishDraft(page);
  await page.goto(`${agreementUrl}/understand`);
  await page.getByRole("link", { name: "Ask a question" }).click();
  await expect(page.getByText(/AI answers are off on this server/)).toHaveCount(0);
  const qa: unknown[] = [];
  const ask = async (q: string, follow: boolean) => {
    const t0 = Date.now();
    await page.getByLabel(follow ? "Follow-up question" : "Your question").fill(q);
    await page.getByRole("button", { name: follow ? "Ask a follow-up" : "Ask" }).click();
    const a = page.getByRole("article", { name: `Answer to: ${q}` });
    await expect(a).toBeVisible({ timeout: 180_000 });
    const text = (await a.innerText()).replace(/\s+/g, " ").slice(0, 1200);
    qa.push({ q, seconds: Math.round((Date.now() - t0) / 1000), sources: await a.locator("figure").count(), text });
    results.qa = qa;
    save();
  };
  await ask("What are the payment terms?", false);
  await ask("How much notice is needed to end this engagement?", true);
  await ask("Who are the parties to this agreement?", true);
  await shot(page, "1-qa");

  // ---------- M2.3: describe, fill in, generate with AI wording ----------
  await page.goto("/app/studio");
  await page.getByLabel("Describe the agreement").fill(
    "A consulting agreement between Northwind Advisory LLC (the consultant) and Acme Widgets Inc (the client). The fee is $12,000, payable within 30 days of invoice, starting 2027-01-15, either party may end it on 30 days' notice, governed by Delaware law, and the client owns the work product.",
  );
  await page.getByRole("button", { name: "Fill in from description" }).click();
  const filled = page.getByText(/Filled in from your description/);
  const suggestErr = page.locator('[role="alert"], .text-red-700').first();
  await expect(filled.or(page.getByText(/AI isn't|didn't answer|Too many/))).toBeVisible({ timeout: 120_000 });
  results.suggest = { filled: await filled.isVisible(), kind: await page.getByLabel("Type of agreement").inputValue() };
  const fields: Record<string, string> = {};
  for (const l of ["Consultant (legal name)", "Client (legal name)", "Fee (with currency, e.g. $5,000)", "Payment due (days after invoice)", "Start date", "Notice period (days)", "Governing law (state or country)"]) {
    const f = page.getByLabel(l);
    if (await f.count()) fields[l] = await f.first().inputValue();
  }
  (results.suggest as Record<string, unknown>).fields = fields;
  void suggestErr;
  save();
  await shot(page, "2-studio-filled");
  // anything the description didn't state stays for the person to fill in
  for (const [l, v] of Object.entries({ "Consultant (legal name)": "Northwind Advisory LLC", "Client (legal name)": "Acme Widgets Inc", "Fee (with currency, e.g. $5,000)": "$12,000", "Payment due (days after invoice)": "30", "Start date": "2027-01-15", "Notice period (days)": "30", "Governing law (state or country)": "Delaware" })) {
    const f = page.getByLabel(l);
    if ((await f.count()) && !(await f.first().inputValue())) await f.first().fill(v);
  }
  const ip = page.getByLabel("Who owns the work product");
  if ((await ip.count()) && !(await ip.inputValue())) await ip.selectOption({ index: 1 });
  await page.getByLabel("Wording notes (optional)").fill("plain English, short sentences");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page).toHaveURL(/\/app\/studio\/drf_/, { timeout: 180_000 });
  const draftUrl = page.url();
  results.generate = { url: draftUrl.replace(/^.*\/app/, "/app"), landing: new URL(draftUrl).searchParams.get("new"), why: new URL(draftUrl).searchParams.get("why"), notice: (await page.locator("main").innerText()).split("\n").find((l) => /Drafted|AI rewording|reworded/i.test(l)) ?? null };
  save();
  await shot(page, "3-studio-draft");

  // edit a clause, export, submit
  await page.getByRole("button", { name: "Edit" }).nth(1).click();
  const box = page.locator("textarea").first();
  await box.fill((await box.inputValue()) + " Each party will keep a copy of this Agreement.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved as a new version.")).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF" }).click();
  const pdfName = (await dl).suggestedFilename();
  const dl2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "DOCX" }).click();
  const docxName = (await dl2).suggestedFilename();
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByText(/Waiting for approval · v2/)).toBeVisible();

  // a second admin approves; the owner publishes
  await page.goto("/app/settings");
  await page.getByPlaceholder("colleague@example.com").fill(`admin-${Date.now()}@example.com`);
  await page.getByLabel("Role for the new teammate").selectOption("admin");
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await admin.goto(invite);
  await admin.getByLabel("Your name").fill("Robin Admin");
  await admin.getByLabel("Choose a password").fill("correct-horse-42");
  await admin.getByRole("button", { name: "Join workspace" }).click();
  await expect(admin).toHaveURL(/\/app$/);
  await admin.goto(draftUrl.split("?")[0]);
  await admin.getByRole("button", { name: "Approve v2" }).click();
  await expect(admin.getByText(/Approved · v2/)).toBeVisible({ timeout: 60_000 });
  await page.goto(draftUrl.split("?")[0]);
  await page.getByRole("button", { name: "Publish to Agreements" }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 120_000 });
  results.studioFlow = { edited: true, pdf: pdfName, docx: docxName, approvedBySecondAdmin: true, published: page.url().replace(/^.*\/app/, "/app") };
  save();
  await shot(page, "4-studio-published");

  // ---------- M3: Knowledge Hub across agreements ----------
  await page.goto("/app/knowledge");
  await page.getByRole("button", { name: "Index agreements" }).click();
  await expect(page.getByText(/Indexed/).first()).toBeVisible({ timeout: 120_000 });
  const m3: unknown[] = [];
  for (const q of ["When are invoices due?", "Which law governs our agreements?", "What is our policy on cryptocurrency payments?"]) {
    const t0 = Date.now();
    await page.locator("#question").fill(q);
    await page.getByRole("button", { name: "Ask" }).click();
    await page.waitForLoadState("networkidle");
    const entry = page.getByRole("list", { name: "Answers" }).locator(":scope > li", { hasText: q }).first();
    await expect(entry).toBeVisible({ timeout: 180_000 });
    m3.push({ q, seconds: Math.round((Date.now() - t0) / 1000), text: (await entry.innerText()).replace(/\s+/g, " ").slice(0, 1200) });
    results.m3 = m3;
    save();
  }
  await shot(page, "5-knowledge");
});
