import { test, expect, devices, type Page } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, uploadAndPublish } from "./helpers";

// Visual regression: key screens on desktop and on a phone, compared against committed baselines.
// Screenshots differ slightly between operating systems (font rendering), so the baselines are per-OS and
// this suite is opt-in: VISUAL=1 npx playwright test e2e/visual.spec.ts   (add --update-snapshots after an
// intended design change, then review the new images before committing them).
test.skip(!process.env.VISUAL, "set VISUAL=1 to run the visual regression suite");

// anything that changes run to run: generated emails, times, ids in links
function dynamic(page: Page) {
  return [
    page.getByText(/\b\d{1,2}:\d{2}\s?(AM|PM)\b|just now|\bago\b|\bUTC\b|\d{4}-\d{2}-\d{2}/),
    // calendar days ("Nov 6, 2026") inside the app, such as published dates in the agreement library
    // client IP addresses (each simulated client gets its own; see helpers.ts signAsClient)
    page.getByText(/\bIP \d+\.\d+\.\d+\.\d+/),
    // SHA-256 fingerprints of freshly sealed PDFs differ every run
    page.getByText(/\b[0-9a-f]{12,}/),
    // the short fingerprint in the checklist is proportional text, so mask its whole row (its width varies)
    page.getByRole("list", { name: "Readiness checks" }).getByRole("listitem").filter({ hasText: /SHA-256/ }),
    // detection time ("found automatically in 1s") depends on the machine's speed
    page.getByText(/found automatically in/),
    page.locator("#main").getByText(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/),
    page.locator('a[href*="/s/"], code'),
    // the signing link is a random token whose rendered width varies, so mask its whole line
    page.locator("p, div").filter({ hasText: /^Signing link:/ }),
    page.locator("p").filter({ hasText: /\/s\/•+/ }),
  ];
}
// Fixed synthetic identities, so text widths (and form values) are identical every run. The test server's
// database starts empty on each run, so these never collide.
async function signupFixed(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Firm name").fill("Northwind Advisory");
  await page.getByLabel("Legal entity name").fill("Northwind Advisory, LLC");
  await page.getByLabel("Your name").fill("Avery Tester");
  await page.getByLabel("Work email").fill("owner-visual@example.com");
  await page.getByLabel("Password").fill("correct-horse-42");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

// the first PDF page has finished drawing (its placeholder is gone); later pages draw as they scroll in
async function rendered(page: Page) {
  await expect(page.locator("[data-page]").first()).toBeVisible();
  await expect(page.locator('[data-page="0"] .animate-pulse')).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(300);
}

// Times and dates are masked, but a mask is as wide as the text under it, and the text changes with the clock:
// "Nov 6, 2026" and "Nov 7, 2026" differ in width (a 32 px drift on the agreement library), and "9:58 AM EST"
// fits a narrow column where "10:20 AM EST" wraps (+13 px on the file page after 10:00). Before comparing,
// every date and time the app renders is pinned to one fixed value of the widest realistic shape (two-digit
// day and hour), so screenshots don't depend on when the suite runs. Layout with long timestamps is checked
// separately, in every run, by e2e/timestamps.spec.ts.
const PINNED: [RegExp, string][] = [
  // fmtDateTime: "Nov 7, 10:20 AM EST"
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2}\s?(AM|PM)(\s?[A-Z]{2,5})?/g, "Dec 28, 12:00 PM EST"],
  // long dates written into agreements: "November 7, 2026"
  [/\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g, "December 28, 2026"],
  // fmtDay and the relative-time fallback: "Nov 7, 2026"
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/g, "Dec 28, 2026"],
  // UTC audit times and ISO dates: "2026-11-07 15:20:11 UTC"
  [/\b\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?/g, "2026-12-28 12:00:00"],
  // relative times: "just now", "5m ago", "3h ago", "2d ago"
  [/\bjust now\b|\b\d+[mhd] ago\b/g, "28d ago"],
  // any remaining clock time: "10:20 AM"
  [/\b\d{1,2}:\d{2}\s?(AM|PM)\b/g, "12:00 PM"],
];

async function pinDates(page: Page) {
  await page.evaluate((rules) => {
    const root = document.querySelector("#main") ?? document.querySelector("main");
    if (!root) return;
    const res = rules.map(([src, flags, to]) => [new RegExp(src, flags), to] as const);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue ?? "";
      let v = t;
      for (const [re, to] of res) v = v.replace(re, to);
      if (v !== t) n.nodeValue = v;
    }
  }, PINNED.map(([re, to]) => [re.source, re.flags, to] as [string, string, string]));
}

async function shot(page: Page, name: string, fullPage = true) {
  await pinDates(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage, mask: dynamic(page), maxDiffPixels: 20, animations: "disabled" });
}

test("public screens", async ({ page }) => {
  await page.goto("/");
  await shot(page, "landing");
  await page.goto("/login");
  await shot(page, "login");
  await page.goto("/signup");
  await shot(page, "signup");
});

test("app screens, desktop and phone", async ({ page, browser }) => {
  await signupFixed(page);
  await shot(page, "overview-empty");
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await page.goto("/app/agreements");
  await shot(page, "agreements");
  await adoptCountersignature(page);
  await page.goto("/app/files/new");
  await shot(page, "new-file");
  const { link, fileUrl } = await newFile(page, { name: "Jordan Sample", email: "client-visual@example.com", ref: "2026-0142" });
  await shot(page, "file");
  await page.goto("/app");
  await shot(page, "overview");
  await page.goto("/app/settings");
  await shot(page, "settings");

  // the same workspace on a phone: shell, menu, overview
  const phone = await browser.newContext({ ...devices["Pixel 7"], storageState: await page.context().storageState() });
  const m = await phone.newPage();
  await m.goto("/app");
  await shot(m, "phone-overview");
  await m.getByRole("button", { name: "Open menu" }).click();
  await expect(m.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await shot(m, "phone-menu", false);
  await phone.close();

  // the client's side on a phone
  const client = await browser.newContext({ ...devices["Pixel 7"] });
  const c = await client.newPage();
  await c.goto(link);
  await shot(c, "phone-sign-intro");
  await client.close();

  // the agreement editor, last so the screens above are unaffected by the draft it creates
  await page.goto("/app/agreements");
  await page.getByRole("button", { name: "Edit fields" }).click();
  await page.waitForURL((u) => /\/app\/agreements\/tv_/.test(u.pathname));
  const editorUrl = page.url();
  await rendered(page);
  await shot(page, "editor", false);
  await page.locator("[data-field-id]").first().click();
  await shot(page, "editor-selected", false);
  const phone2 = await browser.newContext({ ...devices["Pixel 7"], storageState: await page.context().storageState() });
  const p2 = await phone2.newPage();
  await p2.goto("/app/agreements");
  await shot(p2, "phone-agreements");
  await p2.goto(editorUrl);
  await rendered(p2);
  await shot(p2, "phone-editor", false);
  await phone2.close();

  // the file once the client has signed and it's sealed (auto-countersign), desktop and phone
  const signer = await browser.newContext();
  await signAsClient(signer, link);
  await signer.close();
  await page.goto(fileUrl);
  await expect(page.getByRole("heading", { name: "Signed agreement" })).toBeVisible();
  await shot(page, "file-completed");
  const phone3 = await browser.newContext({ ...devices["Pixel 7"], storageState: await page.context().storageState() });
  const p3 = await phone3.newPage();
  await p3.goto(fileUrl);
  await shot(p3, "phone-file-completed");
  await phone3.close();
});
