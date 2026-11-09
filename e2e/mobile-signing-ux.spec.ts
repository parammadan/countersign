import { test, expect, type Page, type Browser, type Locator } from "@playwright/test";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// Signing on a touch screen (Pixel 7 emulation): "Next field" opens the field's pad or text box instead of
// only scrolling to it (both buttons), a checkbox row in "Your fields" ticks the box, the list shows even for
// a single field, no on-screen keyboard opens by itself (focus goes to the dialog, not an input), the signer's
// inputs are 16px (iOS zooms in on smaller ones) and the sheet's height follows the dynamic viewport (dvh).

let n = 0;
async function openRoom(browser: Browser, link: string, use: object = test.info().project.use) {
  const ctx = await browser.newContext(use);
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${150 + (n++ % 40)}` });
  const c = await ctx.newPage();
  await c.goto(link);
  return { ctx, c };
}

async function consent(c: Page) {
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();
  await expect(c.getByRole("progressbar", { name: "Required fields done" })).toBeVisible();
}

const focusedTag = (c: Page) => c.evaluate(() => document.activeElement?.tagName ?? null);
const fontSize = (l: Locator) => l.evaluate((e) => getComputedStyle(e).fontSize);

test("touch: next field opens the input, checkbox rows tick, no keyboard on open, 16px inputs, dvh sheet", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);
  await uploadAndPublish(page, "08-checkboxes-consents.pdf");
  await adoptCountersignature(page);
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });

  const { ctx, c } = await openRoom(browser, link);
  expect(await c.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await consent(c);

  // (2) a checkbox row is a checkbox: tapping it ticks the box (and the box on the page), tapping again unticks
  const list = c.getByRole("list", { name: "Your fields" });
  const boxes = list.getByRole("checkbox");
  expect(await boxes.count()).toBeGreaterThan(0);
  const row = boxes.first();
  await expect(row).toHaveAttribute("aria-checked", "false");
  const onPage = c.locator("[data-fid]").filter({ hasText: "✓" });
  const ticked = await onPage.count();
  await row.tap();
  await expect(row).toHaveAttribute("aria-checked", "true");
  await expect(row).toContainText("Done");
  await expect(onPage).toHaveCount(ticked + 1);
  await expect(c.getByRole("dialog")).toHaveCount(0);
  await row.tap();
  await expect(row).toHaveAttribute("aria-checked", "false");
  await expect(onPage).toHaveCount(ticked);

  // "Next field" on a checkbox only shows it (consent is never ticked for them), so tick them all from the list
  for (const b of await boxes.all()) if ((await b.getAttribute("aria-checked")) !== "true") await b.tap();
  for (const b of await boxes.all()) await expect(b).toHaveAttribute("aria-checked", "true");

  // (1) + (6) "Next field" opens the signature pad; focus is on the dialog, not an input, so no keyboard opens
  await c.getByRole("button", { name: /^Next field$/ }).tap();
  const pad = c.getByRole("dialog", { name: "Adopt your signature" });
  await expect(pad).toBeVisible();
  await expect(pad).toBeFocused();
  expect(await focusedTag(c)).not.toMatch(/^(INPUT|TEXTAREA|SELECT)$/);

  // (5) the sheet is capped by the dynamic viewport height
  expect(await pad.getAttribute("class")).toContain("max-h-[92dvh]");
  const [maxH, vh] = await pad.evaluate((e) => [parseFloat(getComputedStyle(e).maxHeight), window.innerHeight]);
  expect(Math.abs(maxH - 0.92 * vh)).toBeLessThan(2);

  // (4) the typed-signature box is 16px
  const typed = pad.getByRole("textbox", { name: "Your full name" });
  expect(await fontSize(typed)).toBe("16px");

  // Escape still closes the pad and focus goes back to the field it was opened for
  await c.keyboard.press("Escape");
  await expect(pad).toBeHidden();
  await expect(c.locator("[data-fid]:focus")).toHaveCount(1);

  // the bottom button opens it too
  await c.getByRole("button", { name: /^Go to the next required field/ }).tap();
  await expect(pad).toBeVisible();
  await expect(pad).toBeFocused();
  await pad.getByRole("button", { name: "Adopt signature" }).tap();
  await expect(pad).toBeHidden();

  // (1) for a text box: resume a draft with the name emptied, so the name is the next required field
  await c.evaluate(() => {
    const k = Object.keys(sessionStorage).find((x) => x.startsWith("cs-sign-draft:"))!;
    const d = JSON.parse(sessionStorage.getItem(k)!);
    for (const [id, v] of Object.entries(d.values)) if (v === "Jordan Sample") d.values[id] = "";
    sessionStorage.setItem(k, JSON.stringify(d));
  });
  await c.reload();
  await expect(c.getByText("We kept what you'd already filled in on this device.")).toBeVisible();
  await c.getByRole("button", { name: /^Next field$/ }).tap();
  const box = c.getByRole("dialog").filter({ has: c.getByRole("button", { name: "Save" }) });
  await expect(box).toBeVisible();
  await expect(box).toBeFocused();
  const input = box.getByRole("textbox");
  await expect(input).not.toBeFocused();
  expect(await fontSize(input)).toBe("16px");
  await input.tap();
  await expect(input).toBeFocused();
  await input.fill("Jordan Sample");
  await box.getByRole("button", { name: "Save" }).tap();
  await expect(box).toBeHidden();
  await expect(c.getByRole("button", { name: /^Finish/ }).first()).toBeVisible();

  // (4) the decline reason is 16px too, and its dialog doesn't open the keyboard either
  await c.getByRole("button", { name: "Decline to sign" }).tap();
  const decline = c.getByRole("dialog", { name: "Decline to sign" });
  await expect(decline).toBeFocused();
  expect(await fontSize(decline.getByRole("textbox"))).toBe("16px");
  await decline.getByRole("button", { name: "Cancel" }).tap();
  await expect(decline).toBeHidden();

  // and the whole thing still signs
  await c.getByRole("button", { name: /^Finish/ }).first().tap();
  await c.getByRole("dialog", { name: "Sign and finish" }).getByRole("button", { name: "Sign and finish" }).tap();
  await expect(c.getByRole("heading", { name: "All signed" })).toBeVisible({ timeout: 60_000 });
  await ctx.close();
});

test("touch: a single field is listed; inputs stay 16px on a tablet and 14px with a mouse", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signup(page);
  await uploadAndPublish(page, "01-simple-one-page.pdf");
  await adoptCountersignature(page);
  const { link } = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com` });

  // (3) one field still gets the list, and its row opens the pad
  const { ctx, c } = await openRoom(browser, link);
  await consent(c);
  const rows = c.getByRole("list", { name: "Your fields" }).getByRole("button");
  await expect(rows).toHaveCount(1);
  await rows.first().tap();
  const pad = c.getByRole("dialog", { name: /^Adopt your/ });
  await expect(pad).toBeVisible();
  await expect(pad).toBeFocused();
  await c.keyboard.press("Escape");
  await expect(pad).toBeHidden();
  await ctx.close();

  // (4) a touch tablet wider than the phone breakpoint keeps 16px; a mouse-driven desktop keeps the 14px design
  // (consent is saved on the server, so these open straight on the document)
  const tablet = await openRoom(browser, link, { ...test.info().project.use, viewport: { width: 820, height: 1180 } });
  await tablet.c.getByRole("button", { name: "Decline to sign" }).tap();
  const tDecline = tablet.c.getByRole("dialog", { name: "Decline to sign" });
  await expect(tDecline).toBeFocused();
  expect(await fontSize(tDecline.getByRole("textbox"))).toBe("16px");
  await tablet.ctx.close();

  const desk = await openRoom(browser, link, { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  expect(await desk.c.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
  await desk.c.getByRole("button", { name: "Decline to sign" }).click();
  const dDecline = desk.c.getByRole("dialog", { name: "Decline to sign" });
  // with a mouse/keyboard, focus still goes straight into the first input
  await expect(dDecline.getByRole("textbox")).toBeFocused();
  expect(await fontSize(dDecline.getByRole("textbox"))).toBe("14px");
  await desk.ctx.close();
});
