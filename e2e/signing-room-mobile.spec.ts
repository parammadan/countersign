import { test, expect, type Page, type Locator } from "@playwright/test";
import { adoptCountersignature, newFile, signup, uid, uploadAndPublish } from "./helpers";

// The signing room on a phone: progress is visible without a wide screen, dialogs fit and have thumb-sized
// controls, turning the phone while drawing clears the box and says why, and a reload mid-signing keeps
// what the client already did (in this tab only).

async function draw(c: Page, canvas: Locator, points: [number, number][]) {
  const b = (await canvas.boundingBox())!;
  await c.mouse.move(b.x + points[0][0], b.y + points[0][1]);
  await c.mouse.down();
  for (const [x, y] of points.slice(1)) await c.mouse.move(b.x + x, b.y + y, { steps: 4 });
  await c.mouse.up();
}

test("signing on a phone: progress, dialog fit, rotation, and resuming after a reload", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);
  await uploadAndPublish(page, "05-drawn-lines-label-under.pdf");
  await adoptCountersignature(page);
  const { link } = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com` });

  const ctx = await browser.newContext({ ...test.info().project.use });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.241" });
  const c = await ctx.newPage();
  const vp = c.viewportSize()!;
  await c.goto(link);
  await c.getByRole("checkbox").check();
  await c.getByRole("button", { name: "Review and sign" }).click();

  // progress is shown on a phone too, not only on wide screens
  const bar = c.getByRole("progressbar", { name: "Required fields done" });
  const total = Number(await bar.getAttribute("aria-valuemax"));
  const start = Number(await bar.getAttribute("aria-valuenow"));
  expect(total).toBeGreaterThan(start);
  await expect(c.getByText(`${start} of ${total} required done`)).toBeVisible();

  // the field list has thumb-sized rows
  const list = c.getByRole("list", { name: "Your fields" });
  for (const row of await list.getByRole("button").all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // the signature dialog fits the screen and its close button is big enough to hit
  await list.getByRole("button", { name: /Signature.*Required$/ }).click();
  const pad = c.getByRole("dialog", { name: "Adopt your signature" });
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  const close = (await pad.getByRole("button", { name: "Close" }).boundingBox())!;
  expect(Math.min(close.width, close.height)).toBeGreaterThanOrEqual(40);

  // turning the phone clears the drawing (the strokes wouldn't line up any more) and says so
  await pad.getByRole("button", { name: "Draw" }).click();
  const canvas = pad.getByLabel("Draw your signature");
  await draw(c, canvas, [[20, 80], [70, 40], [120, 100], [180, 50]]);
  await expect(pad.getByRole("button", { name: "Adopt signature" })).toBeEnabled();
  await c.setViewportSize({ width: vp.height, height: vp.width });
  await expect(pad.getByRole("alert")).toContainText("changed size, so it was cleared");
  await expect(pad.getByRole("button", { name: "Adopt signature" })).toBeDisabled();
  await c.setViewportSize(vp);
  await draw(c, canvas, [[20, 80], [70, 40], [120, 100], [180, 50]]);
  await pad.getByRole("button", { name: "Adopt signature" }).click();
  await expect(pad).toBeHidden();
  await expect(bar).toHaveAttribute("aria-valuenow", String(start + 1));

  // a reload mid-signing keeps the adopted signature, and says so
  await c.reload();
  await expect(c.getByText("We kept what you'd already filled in on this device.")).toBeVisible();
  await expect(c.getByRole("progressbar", { name: "Required fields done" })).toHaveAttribute("aria-valuenow", String(start + 1));

  // finish (anything still required is filled), and the kept draft is gone afterwards
  for (let i = 0; i < 10 && (await c.getByRole("button", { name: /^Next field$/ }).isVisible()); i++) {
    await c.getByRole("button", { name: /^Next field$/ }).click();
    await c.locator("[data-fid]:focus").click();
    const d = c.getByRole("dialog");
    const save = d.getByRole("button", { name: "Save" });
    const adopt = d.getByRole("button", { name: /Adopt (signature|initials)/ });
    if (await adopt.isVisible().catch(() => false)) await adopt.click();
    else if (await save.isVisible().catch(() => false)) {
      if (!(await d.locator("input").inputValue())) await d.locator("input").fill("Test entry");
      await save.click();
    }
    await expect(d).toBeHidden();
  }
  await c.getByRole("button", { name: /^Finish/ }).first().click();
  await c.getByRole("dialog", { name: "Sign and finish" }).getByRole("button", { name: "Sign and finish" }).click();
  await expect(c.getByRole("heading", { name: "All signed" })).toBeVisible({ timeout: 60_000 });
  expect(await c.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("cs-sign-draft:")))).toEqual([]);
  await ctx.close();
});
