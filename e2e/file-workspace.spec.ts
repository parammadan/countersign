import { test, expect, devices, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { adoptCountersignature, copySigningLink, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// The client file page through every state: what it says is next, which actions it offers (and doesn't),
// and that each one really does what it says. Email is not configured on this server (outbox mode).

const nextStep = (page: Page) => page.getByRole("region", { name: /.+/ }).filter({ hasText: "Next step" });
const stage = (page: Page, text: string) => page.getByRole("list", { name: "Progress" }).getByText(text);
const checklist = (page: Page) => page.getByRole("list", { name: "Readiness checks" });
const details = (page: Page) => page.getByLabel("File details");
const idOf = (url: string) => new URL(url).pathname.split("/").pop()!;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const ACTIONS = ["Send for signature", "Send reminder", "Resend email", "Copy signing link", "Countersign and complete", "Reopen and resend", "Send again", "Resend signed copy", "Void"];
async function offered(page: Page) {
  const out: string[] = [];
  for (const name of ACTIONS) if (await page.getByRole("button", { name, exact: true }).count()) out.push(name);
  return out;
}

test("sent → opened → signed → manual countersign → ready for work, with the right actions at each step", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  await page.goto("/app/settings");
  await page.locator('input[name="auto_countersign"]').uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  const file = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  await page.goto(file.fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Waiting for Riley to open the agreement" })).toBeVisible();
  await expect(nextStep(page)).toContainText("Email delivery isn't configured on this server");
  expect(await offered(page)).toEqual(["Send reminder", "Resend email", "Copy signing link", "Void"]);
  await expect(stage(page, "Done: Sent to client")).toHaveCount(1);
  await expect(stage(page, "In progress: Opened")).toHaveCount(1);
  await expect(checklist(page)).toContainText("Not yet: Client consented to sign electronically");
  await expect(details(page)).toContainText("Recorded in the email log only");
  await expect(details(page)).toContainText(/Next automatically|Automatic reminders are off/);
  await expect(page.getByRole("link", { name: "Master Services Agreement" }).first()).toBeVisible();
  await expect(details(page)).toContainText("Version 1, pinned");

  // the raw signing link is never printed; Copy gives it and says so
  const token = file.link.split("/s/")[1];
  expect(await page.locator("body").innerText()).not.toContain(token);
  await expect(page.getByText(/\/s\/••••••••/)).toBeVisible();

  // reminder: real, logged, and not repeatable within a minute
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText(/^Reminder sent\. Email delivery isn't configured/)).toBeVisible();
  await page.reload();
  await expect(details(page)).toContainText("1 sent");
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText("A reminder went to the client less than a minute ago, so it wasn't sent again.")).toBeVisible();
  await page.goto("/app/outbox");
  await expect(page.getByRole("link", { name: /^Reminder:/ })).toHaveCount(1);

  // the client opens it
  const cctx = await browser.newContext();
  const room = await cctx.newPage();
  await room.goto(file.link);
  await expect(room.getByRole("checkbox")).toBeVisible();
  await page.goto(file.fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Riley opened it and hasn't signed yet" })).toBeVisible();
  await expect(stage(page, "Done: Opened")).toHaveCount(1);
  await room.close();

  // the client signs: auto-countersign is off, so an admin is asked to countersign
  await signAsClient(cctx, file.link);
  await cctx.close();
  await page.goto(file.fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Your countersignature is needed" })).toBeVisible();
  await expect(nextStep(page)).toContainText("Automatic countersigning is off in Settings");
  expect(await offered(page)).toEqual(["Countersign and complete", "Void"]);
  await expect(stage(page, "In progress: Firm countersigned")).toHaveCount(1);
  await expect(page.getByText(/Applies Avery Tester's adopted signature/)).toBeVisible();

  // countersign: complete, sealed, ready for work
  await page.getByRole("button", { name: "Countersign and complete" }).click();
  await expect(nextStep(page).getByRole("heading", { name: "Ready for work", exact: true })).toBeVisible();
  await page.reload();
  expect(await offered(page)).toEqual([]); // nothing left to do; no resend in outbox mode, no void on a completed file
  for (const s of ["Sent to client", "Opened", "Client signed", "Firm countersigned", "Ready for work"]) await expect(stage(page, `Done: ${s}`)).toHaveCount(1);
  await expect(page.getByText("All required checks passed")).toBeVisible();
  for (const c of ["Client consented to sign electronically", "Client signed every required field", "Your firm's countersignature applied", "Final PDF sealed and intact", "File is still active (not voided)"])
    await expect(checklist(page)).toContainText(`Passed: ${c}`);
  await expect(page.getByRole("heading", { name: "Stop this file" })).toHaveCount(0);

  // the signed agreement: download, fingerprint, evidence, verify
  const dl = await page.request.get(`/api/files/${idOf(file.fileUrl)}/document`);
  expect(dl.status()).toBe(200);
  const pdf = await dl.body();
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await expect(page.getByRole("link", { name: "Download signed PDF" })).toHaveAttribute("href", `/api/files/${idOf(file.fileUrl)}/document`);
  await expect(page.getByText(`SHA-256 ${sha(pdf)}`)).toBeVisible();
  await expect(page.getByText(/The stored PDF matches the fingerprint recorded when it was sealed/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Signed agreement" }).getByText(/applied by owner-/)).toBeVisible();
  await expect(page.getByText("Not emailed: email delivery isn't configured on this server.")).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy fingerprint" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sha(pdf));
  const clientCopy = await page.request.get(`/api/files/${idOf(file.fileUrl)}/document?kind=client_signed`);
  expect(clientCopy.status()).toBe(200);
  await page.goto("/verify");
  await page.locator('input[type="file"]').setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Authentic.")).toBeVisible();
});

test("decline, void and expiry each say what happened and offer only what still works", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);

  // decline → Send again reopens it
  const d = await newFile(page, { name: "Casey Placeholder", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  const dc = await browser.newContext();
  const dp = await dc.newPage();
  await dp.goto(d.link);
  await dp.getByRole("button", { name: "I don't want to sign this" }).click();
  await dp.getByRole("dialog").locator("textarea").fill("Synthetic: wrong fee schedule");
  await dp.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
  await expect(dp.getByRole("dialog").getByRole("heading", { name: "Declined" })).toBeVisible();
  await dc.close();
  await page.goto(d.fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "Casey declined to sign" })).toBeVisible();
  await expect(nextStep(page)).toContainText("“Synthetic: wrong fee schedule”");
  await expect(stage(page, "Stopped: Declined by client")).toHaveCount(1);
  expect(await offered(page)).toEqual(["Send again", "Void"]);
  await page.getByRole("button", { name: "Send again" }).click();
  await expect(page.getByText(/^Signing email sent again\./)).toBeVisible();
  await page.reload();
  await expect(nextStep(page).getByRole("heading", { name: "Waiting for Casey to open the agreement" })).toBeVisible();

  // void: confirm, reason recorded, link dead, nothing left to do
  const v = await newFile(page, { name: "Morgan Sample", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  await page.goto(v.fileUrl);
  await page.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByText("The signing link stops working at once")).toBeVisible();
  await page.getByLabel("Reason for voiding").fill("Synthetic: duplicate file");
  await page.getByRole("button", { name: "Void file" }).click();
  await expect(nextStep(page).getByRole("heading", { name: "This file was voided" })).toBeVisible();
  await page.reload();
  expect(await offered(page)).toEqual([]);
  await expect(stage(page, "Stopped: Voided")).toHaveCount(1);
  await expect(details(page)).toContainText("Synthetic: duplicate file");
  await expect(page.getByRole("list", { name: "Audit trail" })).toContainText("Voided by firm");
  const vc = await browser.newContext();
  const vp = await vc.newPage();
  await vp.goto(v.link);
  await expect(vp.getByText("This agreement was withdrawn")).toBeVisible();
  await vc.close();

  // expiry (the link's date is moved into the past, as time would): no link to copy, Reopen restarts the clock
  const e = await newFile(page, { name: "Avery Example", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  const db = new DatabaseSync(".e2e-data/countersign.db");
  db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), idOf(e.fileUrl));
  db.close();
  const ec = await browser.newContext();
  const ep = await ec.newPage();
  await ep.goto(e.link);
  await expect(ep.getByText(/expired/i).first()).toBeVisible();
  await ec.close();
  await page.goto(e.fileUrl);
  await expect(nextStep(page).getByRole("heading", { name: "The signing link expired" })).toBeVisible();
  await expect(stage(page, "Stopped: Link expired")).toHaveCount(1);
  expect(await offered(page)).toEqual(["Reopen and resend", "Void"]);
  await page.getByRole("button", { name: "Reopen and resend" }).click();
  await expect(page.getByText(/^Signing email sent again\./)).toBeVisible();
  await page.reload();
  await expect(nextStep(page).getByRole("heading", { name: "Waiting for Avery to open the agreement" })).toBeVisible();
  const ec2 = await browser.newContext();
  const ep2 = await ec2.newPage();
  await ep2.goto(await copySigningLink(page));
  await expect(ep2.getByRole("checkbox")).toBeVisible(); // signable again
  await ec2.close();
});

test("staff see the workflow but can't countersign; another workspace can't reach the file", async ({ page, browser }) => {
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  await page.goto("/app/settings");
  await page.locator('input[name="auto_countersign"]').uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  const f = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  const cc = await browser.newContext();
  await signAsClient(cc, f.link);
  await cc.close();

  await page.goto("/app/settings");
  await page.getByPlaceholder("colleague@example.com").fill(`staff-${uid()}@example.com`);
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = (await page.locator("code", { hasText: "/invite/" }).first().textContent())!.trim();
  const sc = await browser.newContext();
  const st = await sc.newPage();
  await st.goto(invite);
  await st.getByLabel("Your name").fill("Sam Staff");
  await st.getByLabel("Choose a password").fill("correct-horse-42");
  await st.getByRole("button", { name: "Join workspace" }).click();
  await expect(st).toHaveURL(/\/app$/);
  await st.goto(f.fileUrl);
  await expect(nextStep(st).getByRole("heading", { name: "Waiting for an admin to countersign" })).toBeVisible();
  expect(await offered(st)).toEqual(["Void"]);
  await sc.close();

  const oc = await browser.newContext();
  const o = await oc.newPage();
  await signup(o, "Fakewell Partners", "Fakewell Partners LLP");
  expect((await o.goto(f.fileUrl))!.status()).toBe(404);
  expect(await o.locator("body").innerText()).not.toContain("Jordan Sample");
  expect((await o.request.get(`/api/files/${idOf(f.fileUrl)}/document?kind=client_signed`)).status()).toBe(404);
  await oc.close();
});

test("the file page fits phones and tablets in every state", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const sent = await newFile(page, { name: "Riley Example with a fairly long name", email: `a-long-client-address-${uid()}@example.com`, ref: `FW-${uid()}-${uid()}` });
  const done = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: `FW-${uid()}` });
  const cc = await browser.newContext();
  await signAsClient(cc, done.link);
  await cc.close();
  const state = await page.context().storageState();
  for (const d of ["Pixel 7", "iPad Mini"] as const) {
    const ctx = await browser.newContext({ ...devices[d], storageState: state });
    const m = await ctx.newPage();
    for (const [name, url, primary] of [["sent", sent.fileUrl, "Send reminder"], ["completed", done.fileUrl, null]] as const) {
      await m.goto(url);
      expect(await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${d} ${name}`).toBeLessThanOrEqual(0);
      await expect(nextStep(m)).toBeInViewport();
      if (primary) await expect(m.getByRole("button", { name: primary })).toBeInViewport();
      else await expect(m.getByRole("link", { name: "Download signed PDF" })).toBeVisible();
    }
    await ctx.close();
  }
});
