import { test, expect, devices, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import AxeBuilder from "@axe-core/playwright";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";
import { linkIn, smtpSink } from "./support/smtp-sink";

// The email log (/app/outbox): delivery states, filtering, the empty state, phone and tablet layouts and
// accessibility, and that a signing link is never readable from the log.

const SIZES = [
  { name: "small phone 360", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 740 } } },
  { name: "Pixel 7", use: devices["Pixel 7"] },
  { name: "iPad Mini", use: devices["iPad Mini"] },
];

const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const filters = (p: Page) => p.getByRole("navigation", { name: "Filter by delivery status" });
const panel = (p: Page) => p.getByRole("complementary", { name: "Delivery" });
const emails = (p: Page) => p.getByRole("list", { name: "Emails" }).getByRole("listitem");

// The preview frame is excluded: it holds the stored email itself (the email template, not this page), and it is
// sandboxed without scripts, so axe can't run inside it.
async function audit(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude('iframe[title="Email preview"]').analyze();
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes[0]?.target.join(" ")} | ${v.help}`);
  expect.soft(found, `${name} has accessibility violations`).toEqual([]);
}

/** Everything a person or a script could read from the page: visible text, markup, and the preview frame. */
async function everything(page: Page) {
  const frame = page.frameLocator('iframe[title="Email preview"]');
  const parts = [await page.content(), await page.locator("body").innerText()];
  if (await page.locator('iframe[title="Email preview"]').count()) parts.push(await frame.locator("html").innerHTML());
  return parts.join("\n");
}

test("empty log, a logged invitation, filters, redaction, layouts and accessibility", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);

  // a new workspace: a real empty state, no filters
  await page.goto("/app/outbox");
  await expect(page.getByRole("heading", { name: "Email log", level: 1 })).toBeVisible();
  await expect(page.getByText("No emails yet")).toBeVisible();
  await expect(filters(page)).toHaveCount(0);
  await audit(page, "email log (empty)");

  // send a file: the invitation is logged only (no provider on this server)
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const client = `client-${uid()}@example.com`;
  const file = await newFile(page, { name: "Jordan Sample", email: client, ref: `OUT-${uid()}` });
  const token = file.link.split("/s/")[1];
  expect(token.length).toBeGreaterThan(8);

  await page.goto("/app/outbox");
  await expect(emails(page)).toHaveCount(1);
  const row = emails(page).first();
  await expect(row).toContainText("Invitation to sign");
  await expect(row).toContainText(`to ${client}`);
  await expect(row).toContainText("Logged only");
  await expect(filters(page).getByRole("link", { name: "All 1" })).toHaveAttribute("aria-current", "page");
  for (const f of ["Delivered 0", "Failed 0", "Logged only 1"]) await expect(filters(page).getByRole("link", { name: f })).toBeVisible();
  expect(await everything(page)).not.toContain(token);
  await audit(page, "email log (one email)");

  // filters: each has its own URL, and an empty filter says so and offers the way back
  await filters(page).getByRole("link", { name: "Failed 0" }).click();
  await expect(page).toHaveURL(/\/app\/outbox\?status=failed$/);
  await expect(page.getByText("No emails failed")).toBeVisible();
  await expect(emails(page)).toHaveCount(0);
  await audit(page, "email log (empty filter)");
  await page.getByRole("link", { name: "Show all emails" }).click();
  await expect(page).toHaveURL(/\/app\/outbox$/);
  await filters(page).getByRole("link", { name: "Logged only 1" }).click();
  await expect(page).toHaveURL(/status=logged$/);
  await expect(emails(page)).toHaveCount(1);
  await page.goto("/app/outbox?status=nonsense");
  await expect(filters(page).getByRole("link", { name: "All 1" })).toHaveAttribute("aria-current", "page");

  // the detail page: state, recipient, the withheld note, and the link redacted in the stored copy
  await page.goto("/app/outbox");
  await emails(page).first().getByRole("link").click();
  await expect(page).toHaveURL(/\/app\/outbox\/em_/);
  const detailUrl = page.url();
  const delivery = page.getByRole("complementary", { name: "Delivery" });
  await expect(delivery).toContainText("Logged only");
  await expect(delivery).toContainText("Invitation to sign");
  await expect(delivery).toContainText(client);
  await expect(delivery).toContainText("withheld from it");
  await expect(page.frameLocator('iframe[title="Email preview"]').getByText("[personal link withheld from the log]").first()).toBeVisible();
  expect(await everything(page)).not.toContain(token);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Client file" })).toHaveAttribute("href", new URL(file.fileUrl).pathname);
  await audit(page, "email detail");

  // phone and tablet: no sideways scroll on the list or the detail page, the badge stays on screen
  const state = await page.context().storageState();
  for (const size of SIZES) {
    const ctx = await browser.newContext({ ...size.use, storageState: state });
    const p = await ctx.newPage();
    await p.goto("/app/outbox");
    await expect(emails(p)).toHaveCount(1);
    expect(await overflow(p), `${size.name}: email log scrolls sideways`).toBeLessThanOrEqual(0);
    const badge = emails(p).first().getByText("Logged only");
    const box = (await badge.boundingBox())!;
    expect(box.x + box.width, `${size.name}: badge runs off the right edge`).toBeLessThanOrEqual(p.viewportSize()!.width + 0.5);
    await p.goto(detailUrl);
    await expect(p.getByRole("complementary", { name: "Delivery" })).toBeVisible();
    expect(await overflow(p), `${size.name}: email detail scrolls sideways`).toBeLessThanOrEqual(0);
    expect(await everything(p)).not.toContain(token);
    await ctx.close();
  }
});

// More than 200 emails, written straight into the test database: the counts cover every email in the workspace
// (including failures older than the newest 200), filters and Previous/Next page through all of them, and another
// workspace's emails never appear.
test("a long log: counts, filters and pages cover every email, and only this workspace's", async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, "writes to the local test database");
  test.setTimeout(120_000);
  const owner = await signup(page);
  const tag = uid();
  const db = new DatabaseSync(".e2e-data/countersign.db");
  const ws = (db.prepare("SELECT m.workspace_id AS id FROM members m JOIN users u ON u.id = m.user_id WHERE u.email = ?").get(owner) as { id: string }).id;
  const insert = db.prepare(
    "INSERT INTO emails (id, workspace_id, file_id, kind, to_email, subject, html, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const now = Date.now();
  db.exec("BEGIN");
  // 230 emails, newest first: in the newest 200, every 8th failed and every 8th (offset 4) logged; the 30 oldest all failed.
  // Totals: 150 delivered, 55 failed (30 of them older than the newest 200), 25 logged only.
  for (let i = 0; i < 230; i++) {
    const status = i >= 200 || i % 8 === 0 ? "failed" : i % 8 === 4 ? "logged" : "sent";
    insert.run(`em_${tag}_${String(i).padStart(3, "0")}`, ws, null, "reminder", `bulk${i}@example.com`, `Bulk email ${i}`, "<html><body>Synthetic</body></html>", status, status === "failed" ? "550 mailbox unavailable" : null, new Date(now - (i + 1) * 60_000).toISOString());
  }
  // another workspace's emails, newer than all of these: they must never show
  for (let i = 0; i < 15; i++) {
    insert.run(`em_${tag}_other_${i}`, `ws_other_${tag}`, null, "invite", `other${i}@example.com`, `Other workspace email ${i}`, "<html></html>", ["sent", "failed", "logged"][i % 3], null, new Date(now - 1000).toISOString());
  }
  db.exec("COMMIT");
  db.close();

  const pager = (p: Page) => p.getByRole("navigation", { name: "Email log pages" });
  await page.goto("/app/outbox");
  for (const f of ["All 230", "Delivered 150", "Failed 55", "Logged only 25"]) await expect(filters(page).getByRole("link", { name: f })).toBeVisible();
  await expect(emails(page)).toHaveCount(50);
  await expect(pager(page)).toContainText("Showing 1–50 of 230");
  await expect(pager(page).getByRole("link", { name: "Previous" })).toHaveCount(0);

  // every page of "all": only this workspace's emails, and all 230 of them, once each
  const seen = new Set<string>();
  for (let n = 1; n <= 5; n++) {
    if (n > 1) {
      await pager(page).getByRole("link", { name: "Next" }).click();
      await expect(page).toHaveURL(new RegExp(`/app/outbox\\?page=${n}$`));
    }
    await expect(pager(page)).toContainText(`Showing ${(n - 1) * 50 + 1}–${Math.min(n * 50, 230)} of 230`);
    expect(await page.locator("body").innerText()).not.toContain("Other workspace");
    for (const t of await emails(page).getByRole("link").allInnerTexts()) seen.add(t.trim());
  }
  expect(seen.size).toBe(230);
  await expect(pager(page).getByRole("link", { name: "Next" })).toHaveCount(0);
  await page.goto("/app/outbox?page=99");
  await expect(pager(page)).toContainText("Showing 201–230 of 230");
  await page.goto("/app/outbox?page=abc");
  await expect(pager(page)).toContainText("Showing 1–50 of 230");

  // Failed: 55 across two pages, the oldest failure included, the filter kept by Next and Previous
  await filters(page).getByRole("link", { name: "Failed 55" }).click();
  await expect(page).toHaveURL(/\/app\/outbox\?status=failed$/);
  await expect(emails(page)).toHaveCount(50);
  await expect(pager(page)).toContainText("Showing 1–50 of 55");
  await pager(page).getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/\/app\/outbox\?status=failed&page=2$/);
  await expect(emails(page)).toHaveCount(5);
  await expect(pager(page)).toContainText("Showing 51–55 of 55");
  for (const r of await emails(page).all()) await expect(r).toContainText("Failed");
  await expect(emails(page).filter({ hasText: "Bulk email 229" })).toHaveCount(1);
  await expect(filters(page).getByRole("link", { name: "Failed 55" })).toHaveAttribute("aria-current", "page");
  await audit(page, "email log (failed, page 2)");
  await pager(page).getByRole("link", { name: "Previous" }).click();
  await expect(page).toHaveURL(/\/app\/outbox\?status=failed$/);
  await expect(pager(page)).toContainText("Showing 1–50 of 55");
  await audit(page, "email log (failed, page 1)");

  // Logged only and Delivered return only their state
  await filters(page).getByRole("link", { name: "Logged only 25" }).click();
  await expect(emails(page)).toHaveCount(25);
  for (const r of await emails(page).all()) await expect(r).toContainText("Logged only");
  await expect(pager(page).getByRole("link", { name: "Next" })).toHaveCount(0);
  await page.goto("/app/outbox?status=delivered&page=3");
  await expect(pager(page)).toContainText("Showing 101–150 of 150");
  for (const r of await emails(page).all()) await expect(r).toContainText("Delivered");

  // another workspace's email can't be opened by id
  const res = await page.goto(`/app/outbox/em_${tag}_other_0`);
  expect(res?.status()).toBe(404);
});

// Delivered and failed need a server that really sends: the test mail server from playwright.config.ts,
// talking to a local SMTP sink that can refuse recipients. Not available against an external base URL.
test.describe("with email delivery", () => {
  test.skip(!!process.env.E2E_BASE_URL, "needs the local mail test server");
  const MAIL = "http://localhost:3101";
  const sink = smtpSink(2526);
  test.beforeAll(() => sink.start());
  test.afterAll(() => sink.stop());

  test("delivered and failed emails, with the failure reason and no link in the log", async ({ page }) => {
    test.setTimeout(120_000);
    const owner = `owner-${uid()}@example.com`;
    await page.goto(`${MAIL}/signup`);
    await page.getByLabel("Firm name").fill("Northwind Advisory");
    await page.getByLabel("Legal entity name").fill("Northwind Advisory, LLC");
    await page.getByLabel("Your name").fill("Avery Tester");
    await page.getByLabel("Work email").fill(owner);
    await page.getByLabel("Password").fill("correct-horse-42");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect.poll(() => sink.find(owner, /Confirm your email/)).toBeTruthy();
    const confirmLink = linkIn(sink.find(owner, /Confirm your email/)!.raw, "confirm-email")!;
    const confirmToken = confirmLink.split("/").pop()!;

    await page.goto(confirmLink);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page).toHaveURL(/confirmed=1/);

    // a teammate invitation to a mailbox that refuses mail: it fails with the server's reason
    const teammate = `colleague-${uid()}@example.com`;
    sink.refuse((to) => to === teammate);
    await page.goto(`${MAIL}/app/settings`);
    await page.getByPlaceholder("colleague@example.com").fill(teammate);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByText(`Invite sent to ${teammate}.`)).toBeVisible();
    sink.refuse(() => false);

    await page.goto(`${MAIL}/app/outbox`);
    await expect(emails(page)).toHaveCount(2);
    await expect(filters(page).getByRole("link", { name: "Delivered 1" })).toBeVisible();
    await expect(filters(page).getByRole("link", { name: "Failed 1" })).toBeVisible();
    await expect(filters(page).getByRole("link", { name: "Logged only 0" })).toBeVisible();
    await expect(page.getByText(/Email delivery isn't configured/)).toHaveCount(0);

    const failed = emails(page).filter({ hasText: "Team invitation" });
    await expect(failed).toContainText("Failed");
    await expect(failed).toContainText(/Reason: .*550/);
    const delivered = emails(page).filter({ hasText: "Email confirmation" });
    await expect(delivered).toContainText("Delivered");
    await expect(delivered).not.toContainText("Reason:");
    expect(await everything(page)).not.toContain(confirmToken);
    await audit(page, "email log (delivered and failed)");

    await filters(page).getByRole("link", { name: "Failed 1" }).click();
    await expect(emails(page)).toHaveCount(1);
    await expect(emails(page).first()).toContainText("Team invitation");
    await filters(page).getByRole("link", { name: "Delivered 1" }).click();
    await expect(emails(page)).toHaveCount(1);
    await expect(emails(page).first()).toContainText("Email confirmation");

    // failed detail: the reason, said plainly
    await page.goto(`${MAIL}/app/outbox?status=failed`);
    await emails(page).first().getByRole("link").click();
    await expect(page.getByRole("complementary", { name: "Delivery" })).toContainText("Failed");
    await expect(panel(page).getByRole("alert")).toContainText(/Not delivered\. Reason: .*550/);
    await audit(page, "email detail (failed)");

    // delivered detail: no confirmation link in the stored copy
    await page.goto(`${MAIL}/app/outbox?status=delivered`);
    await emails(page).first().getByRole("link").click();
    await expect(page.getByRole("complementary", { name: "Delivery" })).toContainText("Delivered");
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    expect(await everything(page)).not.toContain(confirmToken);
  });
});
