import { test, expect, devices, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import jsQR from "jsqr";
import { signup } from "./helpers";

// THROWAWAY (integ QA, not for push): axe on the new pages from feat/phone-scan, feat/voice and the documents redesign.
const results: string[] = [];

async function audit(page: Page, name: string, exclude: string[] = []) {
  await expect(page).toHaveTitle(/\S/);
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const s of exclude) b = b.exclude(s);
  const r = await b.analyze();
  for (const v of r.violations)
    results.push(`${name} | ${v.id} (${v.impact}) ${v.nodes.length}x ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" ; ")} | ${v.help}`);
  if (!r.violations.length) results.push(`${name} | clean`);
}

test.afterAll(() => console.log("AXE-RESULTS\n" + results.join("\n")));

const TEXT = `CONSULTING SERVICES AGREEMENT

This Agreement is entered into by and between Northwind Advisory LLC ("Provider"), and Maple Row Studio Ltd ("Client").

Effective Date: March 3, 2026

1. Fees. Client will pay a monthly fee of $4,500.00 for the services.
2. Governing Law. This Agreement is governed by the laws of the State of Delaware.

Provider Signature: ____________________
Client Signature: ____________________`;

test("documents pages", async ({ page }) => {
  await signup(page);
  await page.goto("/app/documents");
  await expect(page.getByRole("heading", { name: "Understand any document with AI" })).toBeVisible();
  await audit(page, "/app/documents");
  await page.getByLabel("Document text").fill(TEXT);
  await page.getByRole("button", { name: "Read the document" }).click();
  await expect(page).toHaveURL(/\/app\/documents\/int_/, { timeout: 30_000 });
  await expect(page.getByText("Ready to prepare").first()).toBeVisible();
  await audit(page, "/app/documents/[id]");
  await page.getByRole("link", { name: "Start a draft in Agreement Studio" }).click();
  await expect(page).toHaveURL(/\/draft$/);
  await audit(page, "/app/documents/[id]/draft");
});

test("scan dialog and phone page", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "203.0.113.77" });
  await signup(page);
  await page.goto("/app/agreements");
  const panel = page.locator("details#upload");
  if (await panel.count()) await panel.locator("summary").click();
  await page.getByRole("button", { name: "Scan with phone" }).click();
  const d = page.getByRole("dialog", { name: "Scan with your phone" });
  await expect(d.getByTestId("scan-status")).toHaveText("Waiting for your phone…");
  await audit(page, "scan dialog (desktop)");
  const img = d.getByRole("img", { name: "QR code to scan pages with your phone" });
  const { w, data } = await img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 400;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff"; g.fillRect(0, 0, 400, 400); g.imageSmoothingEnabled = false;
    g.drawImage(el, 40, 40, 320, 320);
    return { w: 400, data: Array.from(g.getImageData(0, 0, 400, 400).data) };
  });
  const link = jsQR(Uint8ClampedArray.from(data), w, w)!.data;
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  await ctx.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.77" });
  const phone = await ctx.newPage();
  await phone.goto(link);
  await expect(phone.getByRole("heading", { name: "Photograph the agreement" })).toBeVisible();
  await audit(phone, "/scan/[token] (phone, empty)");
  await phone.getByTestId("scan-choose-input").setInputFiles(["fixtures/scan/page-a.jpg", "fixtures/scan/page-b.jpg"]);
  await expect(phone.getByTestId("scan-count")).toHaveText("2 pages");
  await audit(phone, "/scan/[token] (phone, 2 pages)");
  await expect(d.getByTestId("scan-status")).toContainText("Phone connected");
  await audit(page, "scan dialog (phone connected)");
  await ctx.close();
});

test.describe("studio voice", () => {
  test.use({ baseURL: "http://localhost:3102" });
  test("studio panel with voice control", async ({ page }) => {
    await page.addInitScript(() => {
      class R {
        lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
        onstart: ((e: unknown) => void) | null = null; onaudiostart: ((e: unknown) => void) | null = null;
        onresult: ((e: unknown) => void) | null = null; onend: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
        start() { setTimeout(() => { this.onstart?.({}); this.onaudiostart?.({}); this.onresult?.({ resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript: "a consulting agreement" } }] }); }, 50); }
        stop() { setTimeout(() => this.onend?.({}), 50); }
        abort() { this.onend?.({}); }
      }
      Object.defineProperty(window, "SpeechRecognition", { value: R, configurable: true, writable: true });
      Object.defineProperty(window, "webkitSpeechRecognition", { value: R, configurable: true, writable: true });
    });
    await signup(page);
    await page.goto("/app/studio");
    await expect(page.getByRole("button", { name: "Speak instead" })).toBeVisible();
    await audit(page, "/app/studio (voice idle)");
    await page.getByRole("button", { name: "Speak instead" }).click();
    await expect(page.getByTestId("voice-heard")).toContainText("a consulting agreement");
    await audit(page, "/app/studio (voice listening)");
  });
});
