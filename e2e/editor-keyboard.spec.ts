import { test, expect, type Page } from "@playwright/test";
import { signup } from "./helpers";

// Q8-06: keyboard users who open the publish confirmation and back out of it (Escape, Cancel or ×) must land
// back on "Review and publish", not on the page body.

const active = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

test("the publish dialog returns focus to Review and publish, however it's closed", async ({ page }) => {
  await signup(page);
  await page.goto("/app/agreements");
  await page.locator('input[type="file"]').first().setInputFiles("fixtures/agreements/02-msa-two-column.pdf");
  await page.waitForURL(/agreements\/tv_/);
  await expect(page.getByText("found automatically")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Review and publish" });

  for (const close of ["Escape", "Cancel", "Close"] as const) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: /^Publish version/ });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `${close}: focus moved into the dialog`).toBe(true);
    if (close === "Escape") await page.keyboard.press("Escape");
    else {
      // reach the button by keyboard, as a keyboard user would
      const target = dialog.getByRole("button", { name: close });
      for (let i = 0; i < 10 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      await page.keyboard.press("Enter");
    }
    await expect(dialog).toBeHidden();
    await expect(trigger, `${close}: focus is back on Review and publish (was on "${await active(page)}")`).toBeFocused();
  }
});
