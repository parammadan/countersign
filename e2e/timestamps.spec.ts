import { test, expect, type Page } from "@playwright/test";
import { adoptCountersignature, newFile, signAsClient, signup, uid, uploadAndPublish } from "./helpers";

// The visual suite pins every date and time to one value so screenshots don't depend on the clock. This
// check covers what pinning hides: with the widest timestamps the app can render (two-digit day and hour,
// "29d ago", "September 28, 2026"), no screen scrolls sideways and no timestamp spills out of its box, on a
// desktop and on a phone. It runs in every suite run, not only with VISUAL=1.

const WIDEST: [RegExp, string][] = [
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2}\s?(AM|PM)(\s?[A-Z]{2,5})?/g, "Sep 28, 12:59 PM EDT"],
  [/\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g, "September 28, 2026"],
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/g, "Sep 28, 2026"],
  [/\bjust now\b|\b\d+[mhd] ago\b/g, "29d ago"],
];

/** Widen every timestamp on the page, then report sideways scroll and any timestamp outside its container. */
async function widenAndMeasure(page: Page) {
  return page.evaluate((rules) => {
    const res = rules.map(([src, flags, to]) => [new RegExp(src, flags), to] as const);
    const root = document.querySelector("#main") ?? document.body;
    const changed: Element[] = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue ?? "";
      let v = t;
      for (const [re, to] of res) v = v.replace(re, to);
      if (v !== t) {
        n.nodeValue = v;
        if (n.parentElement) changed.push(n.parentElement);
      }
    }
    const spills: string[] = [];
    for (const el of changed) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue; // hidden (for example a collapsed section)
      const box = (el.closest("li, td, section, [role=region], article, [class*='rounded']") ?? root).getBoundingClientRect();
      // truncation with an ellipsis is a deliberate design; overflow past the container is not
      const cs = getComputedStyle(el);
      const truncated = cs.textOverflow === "ellipsis" && cs.overflow !== "visible";
      if (!truncated && (r.right > box.right + 1 || r.left < box.left - 1)) spills.push(`"${el.textContent?.trim().slice(0, 60)}" ${Math.round(r.left)}-${Math.round(r.right)} outside ${Math.round(box.left)}-${Math.round(box.right)}`);
    }
    return { widened: changed.length, sideways: document.documentElement.scrollWidth - window.innerWidth, spills };
  }, WIDEST.map(([re, to]) => [re.source, re.flags, to] as [string, string, string]));
}

test("the widest timestamps fit on every main screen, desktop and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signup(page);
  await uploadAndPublish(page, "02-msa-two-column.pdf");
  await adoptCountersignature(page);
  const open = await newFile(page, { name: "Riley Example", email: `client-${uid()}@example.com`, ref: `TS-${uid()}` });
  const done = await newFile(page, { name: "Jordan Sample", email: `client-${uid()}@example.com`, ref: `TS-${uid()}` });
  const ctx = await browser.newContext();
  await signAsClient(ctx, done.link); // fills every stage: sent, opened, signed, countersigned, ready
  await ctx.close();

  const screens: [string, string][] = [
    ["file page (in progress)", open.fileUrl],
    ["file page (completed)", done.fileUrl],
    ["overview", "/app"],
    ["files list", "/app/files"],
    ["agreement library", "/app/agreements"],
    ["email log", "/app/outbox"],
  ];
  for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    for (const [name, url] of screens) {
      await page.goto(url);
      await expect(page.locator("#main")).toBeVisible();
      const m = await widenAndMeasure(page);
      if (name.startsWith("file page")) expect(m.widened, `${name}: timestamps found to widen`).toBeGreaterThan(2);
      expect.soft(m.sideways, `${vp.name} ${name}: page scrolls sideways by ${m.sideways}px`).toBeLessThanOrEqual(0);
      expect.soft(m.spills, `${vp.name} ${name}: timestamps outside their box`).toEqual([]);
    }
  }
});
