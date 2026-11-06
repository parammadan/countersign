import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { adoptCountersignature, signAsClient, uid, uploadAndPublish } from "./helpers";

// The whole path through REAL email: the server sends over SMTP, this test reads the messages back over IMAP
// and only uses links taken from the delivered emails. Opt-in: point the server's SMTP_* and these IMAP_*
// at a test mailbox (e.g. an Ethereal account, which captures every message sent through it).
const IMAP = process.env.E2E_IMAP_URL; // e.g. imaps://imap.ethereal.email
const USER = process.env.E2E_IMAP_USER;
const PASS = process.env.E2E_IMAP_PASS;
test.skip(!IMAP || !USER || !PASS, "set E2E_IMAP_URL / E2E_IMAP_USER / E2E_IMAP_PASS to run against a real mailbox");

function imap(path: string, cmd?: string) {
  const args = ["-s", "--max-time", "20", "--url", `${IMAP}/${path}`, "--user", `${USER}:${PASS}`];
  if (cmd) args.push("-X", cmd);
  return execFileSync("curl", args, { encoding: "utf8" });
}

// Wait for a delivered message whose raw source contains `needle`; return the decoded source.
async function waitForMail(needle: string, timeoutMs = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = imap("INBOX", `SEARCH TEXT "${needle}"`).match(/\* SEARCH ([\d ]+)/);
    if (found) {
      const uidNum = found[1].trim().split(" ").pop();
      const raw = imap(`INBOX;MAILINDEX=${uidNum}`);
      // undo quoted-printable soft breaks and =3D so links can be read back
      return raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no email containing ${needle} arrived`);
}

test("signup, confirm, invite, sign and receive the copy, all through delivered email", async ({ page, browser }) => {
  test.setTimeout(240_000);
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
  await expect(page.getByText("Confirm your email to send agreements to clients.")).toBeVisible();

  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);

  // before confirming, sending to a client is refused
  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill("Jordan Sample");
  await page.getByLabel("Client email").fill(client);
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page.getByText(/Confirm your email address first/)).toBeVisible();
  await expect(page.getByLabel("Client email")).toHaveValue(client); // the form kept what was typed

  // confirm through the delivered email
  const confirmMail = await waitForMail(owner);
  const confirmLink = confirmMail.match(/https?:\/\/[^\s"'<>]+\/confirm-email\/[A-Za-z0-9_-]+/)![0];
  await page.goto(confirmLink);
  await page.getByRole("button", { name: "Confirm my email" }).click();
  await expect(page).toHaveURL(/\/app\?confirmed=1/);
  await expect(page.getByText("Confirm your email to send agreements to clients.")).toHaveCount(0);

  // now the invitation goes out for real
  await page.goto("/app/files/new");
  await page.getByLabel("Client full name").fill("Jordan Sample");
  await page.getByLabel("Client email").fill(client);
  await page.getByRole("button", { name: "Create and send for signature" }).click();
  await expect(page).toHaveURL(/\/app\/files\/file_/);
  const fileUrl = page.url().split("?")[0];
  await expect(page.getByText(/Email delivery isn't configured/)).toHaveCount(0);

  const invite = await waitForMail(client);
  expect(invite).toMatch(/please review and sign/i);
  const signLink = invite.match(/https?:\/\/[^\s"'<>]+\/s\/[A-Za-z0-9_-]+/)![0];

  // the client signs from the emailed link; the firm countersigns automatically
  const ctx = await browser.newContext();
  await signAsClient(ctx, signLink);
  await ctx.close();

  // the client receives the signed copy with the PDF attached
  const copy = await waitForMail(`Signed: your`);
  expect(copy).toMatch(/Content-Type: application\/pdf/i);

  await page.goto(fileUrl);
  await expect(page.getByRole("heading", { name: "Ready for work" })).toBeVisible();
  await expect(page.locator("li", { hasText: "Passed: Client emailed their signed copy" })).toBeVisible();
});
