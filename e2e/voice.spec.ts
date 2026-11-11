import { test, expect, type Page } from "@playwright/test";
import { signup } from "./helpers";

// Voice input in Studio's AI panel, against a scripted stand-in for the browser's speech recognition (no microphone,
// no speech service, no network). The panel is shown only where AI suggestions are available, so this runs against
// the AI server (playwright.config.ts, port 3102); nothing here asks the model anything. A real microphone and a real
// browser speech service can't be exercised in automation.
test.skip(!!process.env.E2E_BASE_URL, "needs the local AI server");
test.use({ baseURL: "http://localhost:3102" });

declare global {
  interface Window {
    __voice: { mode: "ok" | "denied"; starts: number; lang: string; last: { emit(r: [string, boolean][]): void; speechEnd(): void } | null };
  }
}

/** Replaces both constructors with a fake the test drives: `emit` sends results, `speechEnd` is the silence event. */
async function fakeRecognition(page: Page) {
  await page.addInitScript(() => {
    type Ev = (e: unknown) => void;
    window.__voice = { mode: "ok", starts: 0, lang: "", last: null };
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onstart: Ev | null = null;
      onaudiostart: Ev | null = null;
      onresult: Ev | null = null;
      onspeechend: Ev | null = null;
      onerror: Ev | null = null;
      onend: Ev | null = null;
      private results: { isFinal: boolean; length: number; 0: { transcript: string } }[] = [];
      private ended = false;
      start() {
        const v = window.__voice;
        v.starts++;
        v.lang = this.lang;
        v.last = this;
        setTimeout(() => {
          if (v.mode === "denied") {
            this.onerror?.({ error: "not-allowed" });
            this.end();
            return;
          }
          this.onstart?.({});
          this.onaudiostart?.({});
        }, 80);
      }
      emit(r: [string, boolean][]) {
        // like Chrome: the list holds the session's results; later ones replace the interim tail
        this.results = [...this.results.filter((x) => x.isFinal), ...r.map(([t, isFinal]) => ({ isFinal, length: 1, 0: { transcript: t } }))];
        this.onresult?.({ resultIndex: 0, results: this.results });
      }
      speechEnd() {
        this.onspeechend?.({});
      }
      stop() {
        setTimeout(() => this.end(), 60);
      }
      abort() {
        this.end();
      }
      private end() {
        if (this.ended) return;
        this.ended = true;
        this.onend?.({});
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition, configurable: true, writable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: FakeRecognition, configurable: true, writable: true });
  });
}

/** Counts server-action calls (the AI suggest step is one), so the test can show voice never triggers it. */
function countActions(page: Page) {
  const n = { actions: 0 };
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) n.actions++;
  });
  return n;
}

const box = (page: Page) => page.getByLabel("Tell AI what you need");
const status = (page: Page) => page.locator("#voice-status");

test("speech is added to the box for review; nothing is submitted", async ({ page }) => {
  await fakeRecognition(page);
  await signup(page);
  const calls = countActions(page);
  await page.goto("/app/studio");
  await expect(page.getByRole("button", { name: "Fill details with AI", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try an example" })).toBeVisible(); // the rest of the panel stays
  await expect(page.getByText("Your browser may send your voice to its maker's speech service (for example Google, in Chrome) to turn it into text. AgreementOS never receives audio, only the text you choose to send.")).toBeVisible();

  await box(page).fill("Between Acme Widgets Inc and Northwind Advisory LLC.");
  const mic = page.getByRole("button", { name: "Speak instead" });
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await mic.click();
  await expect(status(page)).toContainText("Listening");
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  // the box may still change while listening, so it can't be sent to Claude (or replaced by the example) meanwhile
  const fill = page.getByRole("button", { name: "Fill details with AI", exact: true });
  const example = page.getByRole("button", { name: "Try an example" });
  await expect(fill).toBeDisabled();
  await expect(example).toBeDisabled();
  expect(await page.evaluate(() => window.__voice.lang)).toBeTruthy();

  // interim words show live, but don't go into the box yet
  await page.evaluate(() => window.__voice.last!.emit([["a consulting agreement for", false]]));
  await expect(page.getByTestId("voice-heard")).toContainText("a consulting agreement for");
  await expect(box(page)).toHaveValue("Between Acme Widgets Inc and Northwind Advisory LLC.");

  // the final words, then silence: the session ends and appends once
  await page.evaluate(() => window.__voice.last!.emit([["A consulting agreement for $12,000 under Delaware law", true]]));
  await page.evaluate(() => window.__voice.last!.speechEnd());
  await expect(status(page)).toContainText("Added to the box above — check it, then press Fill details with AI");
  await expect(box(page)).toHaveValue("Between Acme Widgets Inc and Northwind Advisory LLC. A consulting agreement for $12,000 under Delaware law");
  await expect(fill).toBeEnabled();
  await expect(example).toBeEnabled();

  // the person can still edit it; nothing was suggested or sent
  await box(page).press("End");
  await box(page).pressSequentially(" Thanks.");
  await expect(box(page)).toHaveValue(/Delaware law Thanks\.$/);
  await page.waitForTimeout(500);
  expect(calls.actions).toBe(0);
  await expect(page.getByText(/Claude suggested|Claude is reading|didn't answer/)).toHaveCount(0);

  // Stop by hand: a second dictation is added after the first
  await page.getByRole("button", { name: "Speak instead" }).click();
  await expect(status(page)).toContainText("Listening");
  await page.evaluate(() => window.__voice.last!.emit([["Thirty days notice", true]]));
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(status(page)).toContainText("Added to the box above");
  await expect(box(page)).toHaveValue(/Delaware law Thanks\. Thirty days notice$/);
  expect(calls.actions).toBe(0);
});

test("microphone blocked: says so, offers Retry, leaves the box alone", async ({ page }) => {
  await fakeRecognition(page);
  await page.addInitScript(() => { window.__voice.mode = "denied"; });
  await signup(page);
  const calls = countActions(page);
  await page.goto("/app/studio");
  await box(page).fill("typed by hand");
  await page.getByRole("button", { name: "Speak instead" }).click();
  const blocked = "Microphone access was blocked. Allow it in your browser's site settings, or type instead.";
  await expect(page.getByTestId("voice-input").getByText(blocked).last()).toBeVisible();
  await expect(status(page)).toHaveText(blocked); // announced
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await expect(box(page)).toHaveValue("typed by hand");

  // allowed now: Retry starts listening again
  await page.evaluate(() => { window.__voice.mode = "ok"; });
  await retry.click();
  await expect(status(page)).toContainText("Listening");
  expect(await page.evaluate(() => window.__voice.starts)).toBe(2);
  expect(calls.actions).toBe(0);
});

test("keyboard: the mic is reachable and toggles with Enter", async ({ page }) => {
  await fakeRecognition(page);
  await signup(page);
  await page.goto("/app/studio");
  await box(page).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Speak instead" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeFocused();
  await page.evaluate(() => window.__voice.last!.emit([["by keyboard", true]]));
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveValue("by keyboard");
});

test("unsupported browser: a hint, no mic button", async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) {
      try { delete (window as unknown as Record<string, unknown>)[k]; } catch { /* not configurable */ }
      Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
    }
  });
  await signup(page);
  await page.goto("/app/studio");
  await expect(page.getByRole("button", { name: "Fill details with AI", exact: true })).toBeVisible();
  await expect(page.getByText("Voice input isn't supported in this browser — type instead.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Speak instead" })).toHaveCount(0);
});
