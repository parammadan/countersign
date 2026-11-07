import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { DatabaseSync } from "node:sqlite";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// The client's signing room, field by field: progress, the field list, keyboard focus in and out of dialogs,
// validation on the field itself, drawn-signature checks, one adoption filling every initials box, the
// confirmation, and an honest completion screen whether or not the firm has countersigned yet. Also the
// pages a client sees when the link no longer works. Fixture 07 has three initials boxes, one signature,
// a prefilled required name, an optional title and a date.

async function audit(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("canvas").analyze();
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes[0]?.target.join(" ")} | ${v.help}`);
  expect.soft(found, `${name} has accessibility violations`).toEqual([]);
}

const progress = (c: Page) => c.getByRole("progressbar", { name: "Required fields done" });
const fieldList = (c: Page) => c.getByRole("list", { name: "Your fields" });
const focusedField = (c: Page) => c.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.fid ?? null);

async function draw(c: Page, canvas: Locator, points: [number, number][]) {
  const b = (await canvas.boundingBox())!;
  await c.mouse.move(b.x + points[0][0], b.y + points[0][1]);
  await c.mouse.down();
  for (const [x, y] of points.slice(1)) await c.mouse.move(b.x + x, b.y + y, { steps: 4 });
  await c.mouse.up();
}

async function openRoom(c: Page, link: string) {
  await c.context().setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${200 + Math.floor(Math.random() * 50)}` });
  await c.goto(link);
}

test("signing room: progress, field list, focus, validation, drawn signature and completion", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);
  await uploadAndPublish(page, "07-initials-footer.pdf");
  await adoptCountersignature(page);
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });

  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await openRoom(c, link);

  // consent first: the button says why it's disabled
  const review = c.getByRole("button", { name: "Review and sign" });
  await expect(review).toBeDisabled();
  await expect(c.getByText("Tick the box above to continue.")).toBeVisible();
  await c.getByRole("checkbox").check();
  await expect(c.getByText("Tick the box above to continue.")).toHaveCount(0);
  await review.click();

  // progress: 5 required (3 initials, signature, name; the stamped date isn't counted), the name is already
  // filled from the file
  await expect(progress(c)).toHaveAttribute("aria-valuemax", "5");
  await expect(progress(c)).toHaveAttribute("aria-valuenow", "1");
  await expect(c.getByText("1 of 5 required done")).toBeVisible();
  const list = fieldList(c);
  await expect(list.getByRole("button")).toHaveCount(6); // the date fills itself and isn't listed
  await expect(list.getByRole("button", { name: /^Name.*Done$/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^Title.*Optional$/ })).toBeVisible();
  await audit(c, "signing room (document)");

  // keyboard: Next field focuses the first required field, Enter opens it, Escape returns focus to it
  await c.getByRole("button", { name: /^Next field$/ }).click();
  await expect.poll(() => focusedField(c)).not.toBeNull();
  const first = await focusedField(c);
  await c.keyboard.press("Enter");
  const pad = c.getByRole("dialog", { name: "Adopt your initials" });
  await expect(pad).toBeVisible();
  await expect(pad.getByRole("textbox", { name: "Your initials" })).toBeFocused();
  // Tab stays inside the dialog
  for (let i = 0; i < 8; i++) await c.keyboard.press("Tab");
  expect(await c.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await c.keyboard.press("Escape");
  await expect(pad).toBeHidden();
  expect(await focusedField(c)).toBe(first);

  // one typed adoption fills all three initials boxes; Enter in the box adopts
  await c.keyboard.press("Enter");
  await expect(pad.getByRole("button", { name: "Type" })).toHaveAttribute("aria-pressed", "true");
  await expect(pad.getByRole("button", { name: /JS, style 1/ })).toHaveAttribute("aria-pressed", "true");
  await pad.getByRole("textbox", { name: "Your initials" }).press("Enter");
  await expect(pad).toBeHidden();
  await expect(progress(c)).toHaveAttribute("aria-valuenow", "4");
  await expect(c.getByRole("status").filter({ hasText: "1 required field left." })).toHaveCount(1);
  await expect(list.getByRole("button", { name: /Initials.*Done$/ })).toHaveCount(3);

  // the signature, drawn: a dot is refused with a reason, a real stroke is adopted
  await list.getByRole("button", { name: /^Authorized Signature.*Required$/ }).click();
  const sigPad = c.getByRole("dialog", { name: "Adopt your signature" });
  await expect(sigPad).toBeVisible();
  await sigPad.getByRole("button", { name: "Draw" }).click();
  await expect(sigPad.getByRole("button", { name: "Draw" })).toHaveAttribute("aria-pressed", "true");
  const canvas = sigPad.getByLabel("Draw your signature");
  await draw(c, canvas, [[60, 60], [62, 61]]);
  await sigPad.getByRole("button", { name: "Adopt signature" }).click();
  await expect(sigPad.getByRole("alert")).toContainText("too small to read as a signature");
  await audit(c, "signature pad (draw, error)");
  await sigPad.getByRole("button", { name: "Clear" }).click();
  await expect(sigPad.getByRole("alert")).toHaveCount(0);
  await expect(sigPad.getByRole("button", { name: "Adopt signature" })).toBeDisabled();
  await draw(c, canvas, [[30, 90], [80, 40], [130, 110], [190, 50], [260, 95]]);
  await sigPad.getByRole("button", { name: "Adopt signature" }).click();
  await expect(sigPad).toBeHidden();
  await expect(progress(c)).toHaveAttribute("aria-valuenow", "5");
  await expect(c.getByText("Required done · 1 optional")).toBeVisible();
  await expect(c.getByRole("status").filter({ hasText: "All required fields are done" })).toHaveCount(1);

  // validation on the field: clearing the required name is refused there, with a label and a reason
  await list.getByRole("button", { name: /^Name.*Done$/ }).click();
  const nameBox = c.getByRole("dialog", { name: "Name" });
  const input = nameBox.getByLabel("Name (required)");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Jordan Sample");
  await input.fill("   ");
  await nameBox.getByRole("button", { name: "Save" }).click();
  await expect(nameBox.getByRole("alert")).toHaveText('Fill in "Name".');
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toBeFocused();
  await audit(c, "text field (error)");
  await input.fill("Jordan A. Sample");
  await expect(nameBox.getByRole("alert")).toHaveCount(0);
  await nameBox.getByRole("button", { name: "Save" }).click();
  await expect(nameBox).toBeHidden();
  // the dialog's input took focus on open; closing still returns focus to what opened it (the list jumps to the
  // field on the document first, so that's the opener), not to the page body
  await expect(c.locator("[data-fid]:focus")).toHaveCount(1);
  expect(await c.locator("[data-fid]:focus").getAttribute("aria-label")).toMatch(/Name/);

  // the optional title can be left empty
  await list.getByRole("button", { name: /^Title.*Optional$/ }).click();
  const titleBox = c.getByRole("dialog", { name: "Title" });
  await expect(titleBox.getByLabel("Title (optional)")).toHaveAttribute("autocomplete", "organization-title");
  await titleBox.getByLabel("Title (optional)").fill("Partner");
  await titleBox.getByRole("button", { name: "Save" }).click();
  await expect(c.getByText("Ready to sign")).toBeVisible();

  // confirmation shows what is applied, then an honest completion: auto-countersign is on, so it's complete
  await c.getByRole("button", { name: /^Finish/ }).first().click();
  const confirm = c.getByRole("dialog", { name: "Sign and finish" });
  await expect(confirm.getByRole("img", { name: "Your signature" })).toBeVisible();
  await expect(confirm.getByRole("img", { name: "Your initials" })).toBeVisible();
  await expect(confirm.getByText(/^Dated /)).toBeVisible();
  await audit(c, "sign and finish dialog");
  await confirm.getByRole("button", { name: "Sign and finish" }).click();
  const done = c.getByRole("heading", { name: "All signed" });
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done).toBeFocused();
  await expect(c.getByText(/Both you and Northwind Advisory have signed/)).toBeVisible();
  const steps = c.getByRole("list", { name: "Where this agreement is" });
  await expect(steps.getByText("(done)")).toHaveCount(3);
  const dl = c.getByRole("link", { name: "Download signed copy" });
  const res = await c.request.get((await dl.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await audit(c, "all signed (complete)");
  await ctx.close();
});

test("completion before the firm countersigns says so and offers no dead download", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "05-drawn-lines-label-under.pdf");
  await adoptCountersignature(page);
  await page.goto("/app/settings");
  await page.locator('input[name="auto_countersign"]').uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  const { link } = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com` });

  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  await openRoom(c, link);
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();
  await fieldList(c).getByRole("button", { name: /^Signature.*Required$/ }).click();
  await c.getByRole("dialog", { name: "Adopt your signature" }).getByRole("button", { name: "Adopt signature" }).click();
  await c.getByRole("button", { name: /^Finish/ }).first().click();
  await c.getByRole("dialog", { name: "Sign and finish" }).getByRole("button", { name: "Sign and finish" }).click();
  await expect(c.getByRole("heading", { name: "All signed" })).toBeVisible({ timeout: 60_000 });
  await expect(c.getByText(/Northwind Advisory has your signature and countersigns next/)).toBeVisible();
  await expect(c.getByRole("link", { name: "Download signed copy" })).toHaveCount(0);
  await expect(c.getByRole("list", { name: "Where this agreement is" }).getByText("(next)")).toHaveCount(2);
  await audit(c, "all signed (awaiting countersign)");

  // reopening the link says the same, and a second submission is refused by the server
  await c.reload();
  await expect(c.getByRole("heading", { name: "You've signed" })).toBeVisible();
  const again = await c.request.post(link.replace("/s/", "/api/sign/") + "/complete", { data: { consent: true, values: {}, method: "typed" } });
  expect(again.status()).toBe(409);
  await ctx.close();
});

test("links that no longer work explain why: invalid, withdrawn, expired", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "06-body-blanks.pdf");
  const a = await newFile(page, { name: "Casey Placeholder", email: `client-${uid()}@example.com` });
  await page.getByRole("button", { name: "Void", exact: true }).click();
  await page.getByLabel("Reason for voiding").fill("Synthetic: duplicate file");
  await page.getByRole("button", { name: "Void file" }).click();
  await expect(page.getByText(/voided/i).first()).toBeVisible();
  const b = await newFile(page, { name: "Morgan Sample", email: `client-${uid()}@example.com` });
  const fileId = b.fileUrl.match(/file_[A-Za-z0-9_-]+/)![0];
  const db = new DatabaseSync(".e2e-data/countersign.db");
  db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), fileId);
  db.close();

  const ctx = await browser.newContext();
  const c = await ctx.newPage();
  for (const [url, heading] of [
    [a.link.replace(/[^/]+$/, "not-a-real-token-000000000000"), "This link isn't valid"],
    [a.link, "This agreement was withdrawn"],
    [b.link, "This link has expired"],
  ] as const) {
    await openRoom(c, url);
    await expect(c.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(c.getByRole("main")).toBeVisible();
    await expect(c.locator("[data-fid]")).toHaveCount(0);
    await audit(c, heading);
  }
  // declining from the consent screen also forgets any draft kept in this tab
  const d = await newFile(page, { name: "Sam Sample", email: `client-${uid()}@example.com` });
  const key = `cs-sign-draft:${d.link.split("/").pop()!.slice(-12)}`;
  await openRoom(c, d.link);
  await c.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ values: {} })), key);
  await c.getByRole("button", { name: "I don't want to sign this" }).click();
  const decline = c.getByRole("dialog", { name: "Decline to sign" });
  await decline.getByRole("textbox").fill("Synthetic: wrong agreement");
  await decline.getByRole("button", { name: "Decline" }).click();
  await expect(c.getByRole("dialog", { name: "Declined" })).toBeVisible();
  expect(await c.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();

  // the expired file can't be signed through the API either
  const res = await c.request.post(b.link.replace("/s/", "/api/sign/") + "/complete", { data: { consent: true, values: {}, method: "typed" } });
  expect([409, 410]).toContain(res.status());
  await ctx.close();
});
