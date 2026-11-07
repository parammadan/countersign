import { test, expect, type Page } from "@playwright/test";
import { signup } from "./helpers";

// The firm's countersignature is one image, stamped on every completed agreement next to the countersigner's
// name. Q8-01: the typed signature was taken from "Signing as" only when the pad opened, so changing the name
// afterwards adopted an image of the OLD name under the NEW one. These checks compare the stored image itself
// (the same blob countersigning stamps), not just what the inputs show.

const box = (page: Page) => page.locator("#countersign");
const stored = async (page: Page) => {
  const img = box(page).getByRole("img", { name: "Adopted countersignature" });
  await expect(img).toBeVisible();
  return (await img.getAttribute("src"))!;
};
// adopt, wait for the save to finish (the pad closes), then reload so what's read back is what the server stored
async function adopt(page: Page) {
  await box(page).getByRole("button", { name: "Adopt signature" }).click();
  await expect(box(page).getByRole("button", { name: "Change" })).toBeVisible();
  await page.reload();
}

test("the adopted countersignature reads the name it's adopted under", async ({ page }) => {
  await signup(page);
  await page.goto("/app/settings");
  const name = box(page).getByPlaceholder("Full name");
  const typed = box(page).getByRole("textbox", { name: "Your full name" });

  // reference A: "Avery Tester", adopted straight from a freshly opened pad
  await name.fill("Avery Tester");
  await expect(typed).toHaveValue("Avery Tester");
  await adopt(page);
  const avery = await stored(page);
  await expect(box(page)).toContainText("Avery Tester");

  // the defect: open the pad, then change "Signing as"; the typed signature must follow
  await box(page).getByRole("button", { name: "Change" }).click();
  await name.fill("Jordan Partner");
  await adopt(page);
  const changed = await stored(page);
  await expect(box(page)).toContainText("Jordan Partner");
  expect(changed, "the image must not still read the previous name").not.toBe(avery);

  // reference J: "Jordan Partner" from a freshly opened pad; the image adopted above must be the same image
  await box(page).getByRole("button", { name: "Change" }).click();
  await expect(typed).toHaveValue("Jordan Partner");
  await adopt(page);
  expect(await stored(page), "same name, same style: the same image").toBe(changed);

  // what someone types in the pad themselves is never overwritten, and a mismatch can't be adopted
  await box(page).getByRole("button", { name: "Change" }).click();
  await typed.fill("J. Partner");
  await name.fill("Jordan A. Partner");
  await expect(typed).toHaveValue("J. Partner");
  const warning = box(page).getByRole("alert");
  await expect(warning).toContainText("This signature reads “J. Partner”, but you're signing as “Jordan A. Partner”.");
  await expect(box(page).getByRole("button", { name: "Adopt signature" })).toBeDisabled();
  await typed.press("Enter"); // Enter in the box doesn't get round it
  await expect(box(page).getByRole("button", { name: "Change" })).toHaveCount(0);
  await warning.getByRole("button", { name: "Use “Jordan A. Partner”" }).click();
  await expect(typed).toHaveValue("Jordan A. Partner");
  await expect(warning).toHaveCount(0);
  await adopt(page);
  await expect(box(page)).toContainText("Jordan A. Partner");
  expect(await stored(page)).not.toBe(changed);
});
