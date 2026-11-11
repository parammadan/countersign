import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { signup } from "./helpers";
import { startMockAnthropic, type Script, type VerifyScript } from "./support/mock-anthropic";

// More of "Ask about an agreement" with AI ON (what ask-ai.spec.ts doesn't cover): the withheld answer's evidence
// and what was checked, the per-minute limit, another teammate's conversation, another workspace, and a phone-sized
// screen. Same local mock of the Anthropic API (no network, no cost). Runs in the "ai" project.
const AGREEMENT = [
  "SUPPLY AGREEMENT",
  'This Agreement is made between Fernhill Example Supply LLC ("Supplier") and Oakmere Sample Foods Inc. ("Buyer").',
  "1. Price. The Buyer will pay $2,500 per delivery. Each invoice is payable within 15 days of receipt.",
  "2. Delivery. The Supplier will deliver the goods within 10 business days of each order.",
  "3. Governing law. This Agreement is governed by the laws of the State of Oregon.",
];
async function agreementPdf() {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.TimesRoman);
  const p = doc.addPage([612, 792]);
  AGREEMENT.forEach((l, i) => p.drawText(l, { x: 50, y: 730 - i * 18, size: 9.5, font: f }));
  return Buffer.from(await doc.save());
}
const find = (ps: { id: string; text: string }[], s: string) => ps.find((p) => p.text.includes(s))!;
const answer = (o: Partial<Record<string, unknown>>) => ({ status: "answered", explanation: "", calculations: [], not_stated: [], citations: [], ...o });

const script: Script = (q, ps) => {
  if (/how much/i.test(q)) {
    const price = find(ps, "$2,500");
    return { answer: answer({ answer: "The Buyer pays $2,500 per delivery.", citations: [{ passage: price.id, quote: "The Buyer will pay $2,500 per delivery." }] }) };
  }
  if (/how fast/i.test(q)) {
    const d = find(ps, "10 business days");
    // plausible but wrong (the number of days): only the second check can catch it
    return { answer: answer({ answer: "The Supplier delivers within 5 business days of each order.", citations: [{ passage: d.id, quote: "The Supplier will deliver the goods within 10 business days of each order." }] }) };
  }
  if (/hazard/i.test(q)) return { answer: answer({ status: "not_found", answer: "The agreement doesn't mention hazards.", not_stated: ["Anything about hazards."] }) };
  return { status: 500 };
};
const verify: VerifyScript = (text, ps) => {
  const ev = (s: string) => { const p = find(ps, s); return [{ passage: p.id, quote: s }]; };
  const claims = text.split(/(?<=[.!?])\s+/).filter((c) => c.trim().length > 2).map((claim) => {
    if (/5 business days/.test(claim)) return { span: claim, claim, kind: "term", material: true, verdict: "contradicted", evidence: ev("within 10 business days of each order"), reason: "Clause 2 says 10 business days." };
    return { span: claim, claim, kind: "term", material: true, verdict: "supported", evidence: ev("$2,500 per delivery"), reason: "" };
  });
  return { answer: { claims } };
};

async function ask(page: Page, q: string, followUp = false) {
  await page.getByLabel(followUp ? "Follow-up question" : "Your question").fill(q);
  await page.getByRole("button", { name: followUp ? "Ask a follow-up" : "Ask", exact: true }).click();
  const a = page.getByRole("article", { name: `Answer to: ${q}` });
  await expect(a).toBeVisible({ timeout: 60_000 });
  return a;
}
async function uploadAgreement(page: Page) {
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "supply-agreement.pdf", mimeType: "application/pdf", buffer: await agreementPdf() });
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 90_000 });
  return `${page.url().split("?")[0]}/ask`;
}

test("ask with AI: withheld answer shows its evidence, the minute limit, other workspaces, and a phone-sized screen", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const mock = await startMockAnthropic(script, verify);
  try {
    await signup(page);
    const askUrl = await uploadAgreement(page);
    await page.goto(askUrl);

    // a plausible but wrong answer is withheld: the wrong claim isn't shown, the passage that contradicts it is,
    // and what was checked says which claim failed
    const withheld = await ask(page, "How fast is delivery?");
    await expect(withheld).toContainText(/The second check couldn.t verify the answer against the agreement \(1 contradicted/);
    await expect(withheld).not.toContainText("within 5 business days");
    const src = withheld.getByRole("region", { name: "Sources" });
    await expect(src).toContainText("within 10 business days of each order");
    await expect(src.locator("figcaption").first()).toHaveText(/^Page \d+$/);

    // a good answer stays verified in the same conversation
    const good = await ask(page, "How much per delivery?", true);
    await expect(good).toContainText("Answered from the agreement");
    await expect(good).toContainText("$2,500 per delivery");
    await expect(page.getByRole("list", { name: "Conversation" }).getByRole("article")).toHaveCount(2);

    // the model says the agreement doesn't address it: said so, nothing quoted as an answer
    const nf = await ask(page, "Is there a hazard clause?", true);
    await expect(nf).toContainText("Not found in the agreement");
    await expect(nf).not.toContainText("Answered from the agreement");

    // a reload keeps the conversation (it's stored per agreement version and teammate)
    const threadUrl = page.url();
    expect(threadUrl).toMatch(/\?thread=qa_/);
    await page.reload();
    await expect(page.getByRole("list", { name: "Conversation" }).getByRole("article")).toHaveCount(3);

    const askedSoFar = mock.seen.length;

    // another workspace gets a 404 for the agreement's ask page and never sees the questions
    const other = await (await browser.newContext()).newPage();
    await signup(other, "Southwind Partners", "Southwind Partners, LLC");
    expect((await other.goto(askUrl))!.status()).toBe(404);
    expect(await other.content()).not.toContain("delivery");
    expect((await other.goto(threadUrl))!.status()).toBe(404);
    await other.context().close();
    expect(mock.seen.length).toBe(askedSoFar);

    // a phone-sized screen: the answer, its sources and the composer fit without sideways scrolling
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(threadUrl);
    await expect(page.getByRole("article", { name: "Answer to: How fast is delivery?" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByLabel("Follow-up question")).toBeVisible();
    const box = await page.getByRole("button", { name: "Ask a follow-up" }).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    expect(box && box.height).toBeGreaterThanOrEqual(36);
    await page.setViewportSize({ width: 1280, height: 720 });

    // the key never reaches the browser
    expect(await page.content()).not.toContain("test-not-a-key");
  } finally {
    await mock.close();
  }
});

test("ask with AI: a teammate reads another's conversation but asks in their own; a sixth-plus question in a minute is refused", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const mock = await startMockAnthropic(script, verify);
  try {
    await signup(page);
    const askUrl = await uploadAgreement(page);
    await page.goto(askUrl);
    await ask(page, "How much per delivery?");
    const threadUrl = page.url();

    // invite an admin teammate: they see the owner's conversation read-only
    await page.goto("/app/settings");
    await page.getByPlaceholder("colleague@example.com").fill(`admin-${Math.random().toString(36).slice(2, 8)}@example.com`);
    await page.getByLabel("Role for the new teammate").selectOption("admin");
    await page.getByRole("button", { name: "Invite" }).click();
    const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
    const mate = await (await browser.newContext()).newPage();
    await mate.goto(invite);
    await mate.getByLabel("Your name").fill("Robin Admin");
    await mate.getByLabel("Choose a password").fill("correct-horse-42");
    await mate.getByRole("button", { name: "Join workspace" }).click();
    await expect(mate).toHaveURL(/\/app$/);
    await mate.goto(threadUrl);
    await expect(mate.getByRole("article", { name: "Answer to: How much per delivery?" })).toBeVisible();
    await expect(mate.getByText(/conversation\. Start your own/)).toBeVisible();
    await expect(mate.getByLabel("Follow-up question")).toHaveCount(0);
    await mate.getByRole("link", { name: "Start your own" }).click();
    await expect(mate.getByLabel("Your question")).toBeVisible();
    await mate.context().close();

    // the owner asks quickly: six questions a minute are answered (one above, five here); the seventh is refused
    await page.goto(askUrl);
    for (let i = 2; i <= 6; i++) await ask(page, `Is there a hazard clause ${i}?`, i > 2);
    await page.getByLabel("Follow-up question").fill("Is there a hazard clause 7?");
    await page.getByRole("button", { name: "Ask a follow-up" }).click();
    await expect(page.getByText("You're asking quickly. Wait a minute and try again.")).toBeVisible();
    await expect(page.getByRole("article", { name: "Answer to: Is there a hazard clause 7?" })).toHaveCount(0);
  } finally {
    await mock.close();
  }
});
