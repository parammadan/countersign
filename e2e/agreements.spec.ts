import { test, expect, devices, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import { adoptCountersignature, newFile, publishDraft, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// Step 4: the agreement library and the field editor, through the real UI and API.

const FIX = "fixtures/agreements";
const card = (page: Page, name: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
const num = async (page: Page, label: string) => Number(await page.getByLabel(label, { exact: true }).inputValue());
const box = async (l: Locator) => (await l.boundingBox())!;
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible({ timeout: 10_000 });

async function toFirstPage(page: Page) {
  const prev = page.getByRole("button", { name: "Previous page" });
  await expect(async () => {
    if (await prev.isEnabled()) await prev.click();
    await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

async function dropFile(page: Page, file: string) {
  const b64 = fs.readFileSync(file).toString("base64");
  const name = file.split("/").pop()!;
  await page.getByTestId("agreement-dropzone").first().evaluate(
    (el, [b64, name]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "application/pdf" }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [b64, name],
  );
}

test("library: upload checks, drag and drop, live/draft/archived, search, use", async ({ page }) => {
  await signup(page);
  await page.goto("/app/agreements");
  await expect(page.getByRole("heading", { name: "Upload your client agreement" })).toBeVisible();
  const picker = page.locator('input[type="file"]').first();

  // wrong type, empty, too big: refused before upload, with the reason
  await picker.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByText("“notes.txt” isn't a PDF or Word document")).toBeVisible();
  await picker.setInputFiles({ name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) });
  await expect(page.getByText("“empty.pdf” is empty.")).toBeVisible();
  await picker.setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(21 * 1024 * 1024, 1) });
  await expect(page.getByText(/“huge\.pdf” is 21\.0 MB\. Files up to 20 MB are supported\./)).toBeVisible();
  // named .pdf but isn't one: the server reads the bytes, refuses it, and nothing is created
  await picker.setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf") });
  await expect(page.getByText("Upload a PDF or Word document (.pdf, .docx, .doc, .odt, .rtf).")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/agreements$/);

  // drag and drop an unfamiliar agreement
  await dropFile(page, `${FIX}/05-drawn-lines-label-under.pdf`);
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await expect(page.getByText("found automatically")).toBeVisible();
  await page.goto("/app/agreements");
  const nav = page.getByRole("navigation", { name: "Filter agreements" });
  await expect(nav.getByRole("link", { name: "Drafts 1" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Live 0" })).toBeVisible();
  const first = page.getByRole("listitem").filter({ hasText: "Draft, not published" });
  await expect(first).toHaveCount(1);
  const firstName = (await first.getByRole("heading").textContent())!.trim();
  await first.getByRole("link", { name: "Review draft v1" }).click();
  await publishDraft(page);

  // a second agreement through the header button and the upload panel
  await page.getByRole("button", { name: "Upload agreement" }).click();
  await page.locator("#upload").locator('input[type="file"]').setInputFiles(`${FIX}/03-stacked-provider-customer.pdf`);
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  await publishDraft(page);
  await expect(nav.getByRole("link", { name: "Live 2" })).toBeVisible();
  const second = page.getByRole("listitem").filter({ has: page.getByRole("heading") }).filter({ hasNotText: firstName }).first();
  const secondName = (await second.getByRole("heading").first().textContent())!.trim();
  await expect(card(page, secondName).getByText("Live: version 1")).toBeVisible();
  await expect(card(page, firstName).getByText("Default")).toBeVisible();

  // Use opens a new file with that agreement chosen
  await card(page, secondName).getByRole("link", { name: "Use for a new file" }).click();
  await expect(page).toHaveURL(/\/app\/files\/new\?template=tpl_/);
  await expect(page.locator('select[name="templateId"]')).toHaveValue(new URL(page.url()).searchParams.get("template")!);

  // archive: gone from All and from new files, listed under Archived, restorable
  await page.goto("/app/agreements");
  page.once("dialog", (d) => d.accept());
  await card(page, secondName).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(`“${secondName}” is archived. It's no longer offered for new files`)).toBeVisible();
  await expect(nav.getByRole("link", { name: "Archived 1" })).toBeVisible();
  await expect(card(page, secondName)).toHaveCount(0);
  await page.goto("/app/files/new");
  await expect(page.locator('select[name="templateId"]')).toHaveCount(0); // one agreement left, so no picker
  await page.goto("/app/agreements?view=archived");
  await expect(card(page, secondName).getByText("Archived", { exact: true })).toBeVisible();
  await expect(card(page, secondName).getByRole("link", { name: "Use for a new file" })).toHaveCount(0);
  await card(page, secondName).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(`“${secondName}” is restored`)).toBeVisible();
  await page.goto("/app/agreements");
  await expect(card(page, secondName)).toBeVisible();

  // search by name and by uploaded file name
  await page.getByLabel("Search agreements").fill("zzz-nothing");
  await page.getByLabel("Search agreements").press("Enter");
  await expect(page.getByText("No agreements match “zzz-nothing”")).toBeVisible();
  await page.getByRole("link", { name: "Clear the search" }).click();
  await page.getByLabel("Search agreements").fill("stacked-provider");
  await page.getByLabel("Search agreements").press("Enter");
  await expect(page.getByRole("list", { name: "Agreements" }).getByRole("heading")).toHaveText([secondName]);
});

test("editor: correct detected fields, add, move, resize, delete, undo, zoom, pages, keyboard; versions stay pinned; signing still works", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles(`${FIX}/04-defined-terms-company-client.pdf`);
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/, { timeout: 60_000 });
  const v1Url = page.url();
  await expect(page.getByText("found automatically")).toBeVisible();
  const fieldsOn = (p: number) => page.locator(`[data-page="${p}"] [data-field-id]`);
  await expect(fieldsOn(2)).toHaveCount(8); // detected on the signature page
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  // a click with no change doesn't count as an edit
  await fieldsOn(2).first().click();
  await expect(page.getByRole("heading", { name: "Selected field" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  // correct a detected field: the client's title line becomes optional text, then delete and undo it
  const title = page.getByRole("button", { name: /Client signs: Title/ });
  await title.click();
  await page.getByLabel("Required").uncheck();
  await expect(page.getByText("Optional: the client may leave it blank.")).toBeVisible();
  await page.getByRole("button", { name: "Delete field" }).click();
  await expect(fieldsOn(2)).toHaveCount(7);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(fieldsOn(2)).toHaveCount(8);

  // page navigation (the indicator follows whichever page is most on screen)
  await toFirstPage(page);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Page 2 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByText("Page 1 of 3")).toBeVisible();

  // add client initials on page 1 by clicking the page
  await page.getByRole("button", { name: "Client initials" }).click();
  const p0 = page.locator('[data-page="0"]');
  const pb = await box(p0);
  await p0.click({ position: { x: pb.width * 0.8, y: pb.height * 0.9 } });
  await expect(fieldsOn(0)).toHaveCount(1);
  const added = fieldsOn(0).first();
  await expect(page.getByRole("heading", { name: "Selected field" })).toBeVisible();
  const pts = 612 / pb.width; // points per screen pixel at 100% (letter page)
  expect(Math.abs((await num(page, "Left")) + 30 - pb.width * 0.8 * pts)).toBeLessThan(2); // centred on the click

  // its position on the page is the same at every zoom
  const rel = async () => {
    const [b, p] = [await box(added), await box(p0)];
    return { x: (b.x - p.x) / p.width, y: (b.y - p.y) / p.height, w: b.width / p.width };
  };
  const at100 = await rel();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByText("150%")).toBeVisible();
  await expect.poll(async () => (await box(p0)).width).toBeGreaterThan(pb.width * 1.4);
  const at150 = await rel();
  for (const k of ["x", "y", "w"] as const) expect(Math.abs(at150[k] - at100[k])).toBeLessThan(0.003);

  // drag at 150%: the move in points is the screen move divided by the zoomed scale
  await added.scrollIntoViewIfNeeded();
  const scale150 = (await box(p0)).width / 612;
  const [left0, top0] = [await num(page, "Left"), await num(page, "Top")];
  let b = await box(added);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 90, b.y + b.height / 2 - 45, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await num(page, "Left")) - (left0 - 90 / scale150))).toBeLessThanOrEqual(1);
  expect(Math.abs((await num(page, "Top")) - (top0 - 45 / scale150))).toBeLessThanOrEqual(1);

  // resize by the corner handle
  const w0 = await num(page, "Width");
  b = await box(added);
  await page.mouse.move(b.x + b.width - 3, b.y + b.height - 3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 3 + 60, b.y + b.height - 3, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await num(page, "Width")) - (w0 + 60 / scale150))).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => num(page, "Width")).toBe(w0);
  await page.getByRole("button", { name: "Fit width" }).click();
  await expect(page.getByText("100%")).toBeVisible();

  // it can't leave the page: dragged far off, typed negative, nudged past the edge
  b = await box(added);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 5000, b.y + 5000, { steps: 4 });
  await page.mouse.up();
  expect((await num(page, "Left")) + (await num(page, "Width"))).toBeLessThanOrEqual(612);
  expect((await num(page, "Top")) + (await num(page, "Height"))).toBeLessThanOrEqual(792);
  await page.getByLabel("Left", { exact: true }).fill("-50");
  await expect.poll(() => num(page, "Left")).toBe(0);

  // keyboard: focus, nudge, resize, delete; place a field without a mouse
  await added.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => num(page, "Left")).toBe(1);
  // (it sits on the bottom edge after the drag above, so it can only get smaller there)
  const w = await num(page, "Width");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(() => num(page, "Width")).toBe(w - 1);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => num(page, "Left")).toBe(0);
  await page.keyboard.press("Delete");
  await expect(fieldsOn(0)).toHaveCount(0);
  await page.getByRole("button", { name: "Client initials" }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Page to place it on").selectOption({ label: "page 1" });
  await page.getByRole("button", { name: "Place in the middle" }).click();
  await expect(fieldsOn(0)).toHaveCount(1);
  await expect.poll(async () => Math.round((await num(page, "Left")) + (await num(page, "Width")) / 2)).toBe(306);

  // the field list jumps to a field on another page
  await page.getByRole("complementary", { name: "Fields" }).getByRole("button", { name: /^Signature · Client signs/ }).click();
  await expect(page.getByRole("button", { name: /Client signs: Signature/ })).toBeFocused();

  // everything above is saved: reload and it's there
  await saved(page);
  await page.reload();
  await expect(fieldsOn(0)).toHaveCount(1);
  await expect(fieldsOn(2)).toHaveCount(8);
  await expect(page.getByRole("button", { name: /Client signs: Title/ })).toBeVisible();

  // publish: the dialog states the consequences and wants a confirmation
  await page.getByRole("button", { name: "Review and publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish version 1?" });
  await expect(dialog).toContainText("Every new file will use version 1.");
  await expect(dialog.getByRole("button", { name: "Publish version 1" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await publishDraft(page);
  await adoptCountersignature(page);
  const fileA = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com`, ref: `PIN-${uid()}` });
  await expect(page.getByText(/· version 1 ·/).first()).toBeVisible();

  // version 2: edit fields of the published version, add a required field, publish
  await page.goto(v1Url);
  await expect(page.getByText(/Read-only: files already sent keep exactly this version/)).toBeVisible();
  await expect(page.getByText("1 client file use this version")).toBeVisible();
  await page.getByRole("button", { name: "Edit fields (new version)" }).click();
  await page.waitForURL((u) => /\/app\/agreements\/tv_/.test(u.pathname) && u.toString() !== v1Url);
  await page.getByRole("button", { name: "Client text" }).click();
  await page.getByLabel("Page to place it on").selectOption({ label: "page 1" });
  await page.getByRole("button", { name: "Place in the middle" }).click();
  await page.getByLabel("Label").fill("Extra v2 field");
  await page.getByLabel("Top", { exact: true }).fill("100"); // clear of the initials in the middle
  await expect(page.getByText(/cover each other/)).toHaveCount(0);
  await page.getByLabel("Required").check();
  await saved(page);
  await page.getByRole("button", { name: "Review and publish" }).click();
  await expect(page.getByRole("dialog")).toContainText("The 1 client file already sent with it stay on version 1, exactly as sent.");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await publishDraft(page);
  const hist = page.getByRole("list", { name: /^Versions of / });
  await expect(hist.getByRole("listitem").nth(0)).toContainText("Version 2");
  await expect(hist.getByRole("listitem").nth(0)).toContainText("Live");
  await expect(hist.getByRole("listitem").nth(1)).toContainText("Previous");
  await expect(hist.getByRole("listitem").nth(1)).toContainText("1 client file");
  const fileB = await newFile(page, { name: "Casey Placeholder", email: `client-${uid()}@example.com`, ref: `PIN-${uid()}` });
  await expect(page.getByText(/· version 2 ·/).first()).toBeVisible();
  await page.goto(fileA.fileUrl);
  await expect(page.getByText(/· version 1 ·/).first()).toBeVisible();

  // the client of file A signs version 1 (no extra field), file B's client signs version 2 (with it)
  for (const [f, extra] of [[fileA, 0], [fileB, 1]] as const) {
    const ctx = await browser.newContext();
    const c = await ctx.newPage();
    await c.goto(f.link);
    await c.getByRole("checkbox").check();
    await c.getByRole("button", { name: "Review and sign" }).click();
    await expect(c.locator("[data-fid]").first()).toBeVisible();
    const count = await c.locator("[data-fid]").count();
    // the client sees their own fields only: 4 detected + the initials, and v2 adds one more
    expect(count).toBe(extra ? 6 : 5);
    await c.close();
    await signAsClient(ctx, f.link);
    await ctx.close();
    await page.goto(f.fileUrl);
    await expect(page.getByRole("heading", { name: "Ready for work" })).toBeVisible();
  }
});

test("staff can look but not change agreements; other workspaces can't reach them", async ({ page, browser }) => {
  await signup(page, "Northwind Advisory", "Northwind Advisory, LLC");
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await page.getByRole("button", { name: "Edit fields" }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/);
  const draftId = new URL(page.url()).pathname.split("/").pop()!;
  const agreementName = (await page.locator("h1").textContent())!.replace(/^Check the fields in “|”$/g, "");

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

  await st.goto("/app/agreements");
  await expect(st.getByText("Only admins can upload, edit or publish them.")).toBeVisible();
  for (const name of ["Upload agreement", "Archive", "Rename", "Upload new version", "Edit fields"]) await expect(st.getByRole("button", { name })).toHaveCount(0);
  await expect(st.locator('input[type="file"]')).toHaveCount(0);
  await expect(st.getByRole("link", { name: "Use for a new file" })).toBeVisible();
  await st.getByRole("link", { name: "View draft v2" }).click();
  await expect(st.getByText("This draft is waiting for an admin")).toBeVisible();
  await expect(st.getByRole("button", { name: "Review and publish" })).toHaveCount(0);
  await expect(st.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect((await st.request.put(`/api/versions/${draftId}/fields`, { data: { fields: [] } })).status()).toBe(403);
  expect((await st.request.post(`/api/versions/${draftId}/publish`)).status()).toBe(403);
  expect((await st.request.post("/api/agreements/upload", { multipart: { file: { name: "a.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(`${FIX}/01-simple-one-page.pdf`) } } })).status()).toBe(403);
  await sc.close();

  const oc = await browser.newContext();
  const o = await oc.newPage();
  await signup(o, "Fakewell Partners", "Fakewell Partners LLP");
  expect((await o.goto(`/app/agreements/${draftId}`))!.status()).toBe(404);
  expect((await o.request.get(`/api/versions/${draftId}/pdf`)).status()).toBe(404);
  expect((await o.request.put(`/api/versions/${draftId}/fields`, { data: { fields: [] } })).status()).toBe(404);
  expect((await o.request.post(`/api/versions/${draftId}/publish`)).status()).toBe(404);
  await o.goto("/app/agreements");
  await expect(o.getByText(agreementName)).toHaveCount(0);
  await oc.close();

  // the owner's draft was not touched by either
  await page.goto(`/app/agreements/${draftId}`);
  await expect(page.locator("[data-field-id]").first()).toBeVisible();
});

test("library and editor fit phones and tablets", async ({ page, browser }) => {
  await signup(page);
  await uploadAndPublish(page, "04-defined-terms-company-client.pdf");
  await page.getByRole("button", { name: "Edit fields" }).click();
  await expect(page).toHaveURL(/\/app\/agreements\/tv_/);
  const editor = page.url();
  const state = await page.context().storageState();
  for (const d of ["Pixel 7", "iPad Mini"] as const) {
    const ctx = await browser.newContext({ ...devices[d], storageState: state });
    const m = await ctx.newPage();
    for (const url of ["/app/agreements", editor]) {
      await m.goto(url);
      await m.waitForTimeout(500);
      expect(await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${d} ${url}`).toBeLessThanOrEqual(0);
    }
    // the toolbar, a field and publishing are all reachable on the device
    await expect(m.getByRole("toolbar", { name: "Document" })).toBeInViewport();
    await m.getByRole("button", { name: /Client signs: Signature/ }).scrollIntoViewIfNeeded();
    await m.getByRole("button", { name: /Client signs: Signature/ }).tap();
    await expect(m.getByText(/^Selected:/)).toBeVisible(); // both are below the two-column breakpoint
    await m.getByRole("button", { name: "Review and publish" }).scrollIntoViewIfNeeded();
    await expect(m.getByRole("button", { name: "Review and publish" })).toBeInViewport();
    await ctx.close();
  }
});
