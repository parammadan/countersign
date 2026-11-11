import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { signup } from "./helpers";

// Voice input in Studio's AI panel, against a scripted stand-in for the browser's speech recognition (no microphone,
// no speech service, no network) that behaves like the real ones do: Chrome's growing result list over many result
// events, Safari ending a run by itself after a phrase, Safari's service-not-allowed (Dictation off), a blocked
// microphone. The panel is shown only where AI suggestions are available, so this runs against the AI server
// (playwright.config.ts, port 3102); nothing here asks the model anything. A real microphone and a real browser
// speech service can't be exercised in automation.
test.skip(!!process.env.E2E_BASE_URL, "needs the local AI server");
const STATE = path.join("test-results", "voice-state.json");
test.use({ baseURL: "http://localhost:3102", storageState: STATE });

// one account for the whole file (each test gets a fresh page signed in as it)
test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const ctx = await browser.newContext({ baseURL: "http://localhost:3102", storageState: undefined });
  const page = await ctx.newPage();
  await signup(page);
  await ctx.storageState({ path: STATE });
  await ctx.close();
});

type Mode = "ok" | "denied" | "dictation-off" | "silent";
declare global {
  interface Window {
    __voice: {
      mode: Mode;
      starts: number;
      runs: number;
      lang: string;
      last: { emit(r: [string, boolean][]): void; browserEnd(): void } | null;
    };
    __perm?: { state: string; onchange: null | (() => void) };
  }
}

/**
 * Replaces both constructors with a fake the test drives. `emit` adds results to the run's list (finals stay, the
 * interim tail is replaced) and sends a result event from the first changed index, as Chrome does; `browserEnd` ends
 * the run on its own, as Safari does after a phrase; `stop()` finalises any interim words, then ends.
 */
async function fakeRecognition(page: Page, mode: Mode = "ok") {
  await page.addInitScript((m) => {
    type Ev = (e: unknown) => void;
    type R = { isFinal: boolean; length: number; 0: { transcript: string } };
    window.__voice = { mode: m as Mode, starts: 0, runs: 0, lang: "", last: null };
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
      private results: R[] = [];
      private ended = false;
      constructor() {
        window.__voice.runs++;
      }
      start() {
        const v = window.__voice;
        v.starts++;
        v.lang = this.lang;
        v.last = this;
        if (!this.continuous || !this.interimResults) throw new Error("expected continuous dictation with interim results");
        setTimeout(() => {
          if (v.mode === "silent") return; // a permission prompt left open or dismissed: no event at all
          if (v.mode === "denied" || v.mode === "dictation-off") {
            this.onerror?.({ error: v.mode === "denied" ? "not-allowed" : "service-not-allowed" });
            this.end();
            return;
          }
          this.onstart?.({}); // no onaudiostart, like Chrome on Android
        }, 60);
      }
      emit(r: [string, boolean][]) {
        const keep = this.results.filter((x) => x.isFinal);
        const resultIndex = keep.length;
        this.results = [...keep, ...r.map(([t, isFinal]) => ({ isFinal, length: 1, 0: { transcript: t } }) as R)];
        this.onresult?.({ resultIndex, results: this.results });
      }
      browserEnd() {
        this.end();
      }
      stop() {
        setTimeout(() => {
          if (this.results.some((x) => !x.isFinal)) {
            this.results = this.results.map((x) => ({ ...x, isFinal: true }));
            this.onresult?.({ resultIndex: 0, results: this.results });
          }
          this.end();
        }, 60);
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
  }, mode);
}

/** Makes navigator.permissions report the microphone as `state` (changeable later through window.__perm). */
async function micPermission(page: Page, state: "granted" | "prompt" | "denied") {
  await page.addInitScript((s) => {
    const st = { state: s, onchange: null };
    window.__perm = st;
    const orig = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, "query", {
      configurable: true,
      value: (d: { name: string }) => (d?.name === "microphone" ? Promise.resolve(st) : orig(d as PermissionDescriptor)),
    });
  }, state);
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
const last = (page: Page) => ({
  emit: (r: [string, boolean][]) => page.evaluate((x) => window.__voice.last!.emit(x), r),
  browserEnd: () => page.evaluate(() => window.__voice.last!.browserEnd()),
});

test("Chrome-style dictation over many result events: added once, tidied, cursor at the end, nothing submitted", async ({ page }) => {
  await fakeRecognition(page);
  const calls = countActions(page);
  await page.goto("/app/studio");
  await expect(page.getByRole("button", { name: "Try an example" })).toBeVisible(); // the rest of the panel stays
  await expect(page.getByText(/may send your voice to its maker's speech service/)).toBeVisible();

  await box(page).fill("Between Acme Widgets Inc and Northwind Advisory LLC.");
  const mic = page.getByRole("button", { name: "Speak instead" });
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await mic.click();
  await expect(status(page)).toContainText("Listening");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__voice.lang)).toBeTruthy();
  // the box may still change while listening, so it can't be sent to Claude (or replaced by the example) meanwhile
  const fill = page.getByRole("button", { name: "Fill details with AI", exact: true });
  const example = page.getByRole("button", { name: "Try an example" });
  await expect(fill).toBeDisabled();
  await expect(example).toBeDisabled();

  // Chrome: lowercase, no punctuation; finals stay in the list, the interim tail keeps changing
  await last(page).emit([["a consulting", false]]);
  await expect(page.getByTestId("voice-heard")).toContainText("a consulting");
  await last(page).emit([["a consulting agreement for $12,000", true]]);
  await last(page).emit([["under delaware", false]]);
  await last(page).emit([["under delaware law", true]]);
  await last(page).emit([["thirty days", false]]);
  await expect(page.getByTestId("voice-heard")).toHaveText(/a consulting agreement for \$12,000 under delaware law thirty days$/);
  await expect(box(page)).toHaveValue("Between Acme Widgets Inc and Northwind Advisory LLC."); // nothing in the box yet

  await page.getByRole("button", { name: "Stop" }).click(); // stop finalises the interim tail
  await expect(status(page)).toContainText("Added to the box above — check it, then press Fill details with AI");
  // tidied once for the whole dictation: one capital, one full stop, nothing between Chrome's pause-split chunks
  const expected = "Between Acme Widgets Inc and Northwind Advisory LLC. A consulting agreement for $12,000 under delaware law thirty days.";
  await expect(box(page)).toHaveValue(expected);
  // ready to edit: focused, cursor after the last character
  await expect(box(page)).toBeFocused();
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([expected.length, expected.length]);
  await page.keyboard.type(" Notice.");
  await expect(box(page)).toHaveValue(`${expected} Notice.`);
  await expect(fill).toBeEnabled();
  await expect(example).toBeEnabled();

  await page.waitForTimeout(500);
  expect(calls.actions).toBe(0);
  await expect(page.getByText(/Claude suggested|Claude is reading|didn't answer/)).toHaveCount(0);
});

test("Safari-style: the browser ends the run after each phrase; it listens on, and nothing is lost or doubled", async ({ page }) => {
  await fakeRecognition(page);
  const calls = countActions(page);
  await page.goto("/app/studio");
  await page.getByRole("button", { name: "Speak instead" }).click();
  await expect(status(page)).toContainText("Listening");
  await last(page).emit([["i need a consulting agreement", false]]); // Safari rarely marks results final
  await last(page).browserEnd();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible(); // still listening
  await expect.poll(() => page.evaluate(() => window.__voice.runs)).toBe(2);
  await last(page).emit([["between acme and northwind", false]]);
  await expect(page.getByTestId("voice-heard")).toHaveText(/i need a consulting agreement between acme and northwind$/);
  await last(page).browserEnd();
  await expect.poll(() => page.evaluate(() => window.__voice.runs)).toBe(3);
  await last(page).browserEnd(); // a run that hears nothing: silence ends the dictation
  await expect(status(page)).toContainText("Added to the box above");
  await expect(box(page)).toHaveValue("I need a consulting agreement between acme and northwind.");
  expect(calls.actions).toBe(0);
});

test("microphone blocked during the session: says so, offers Retry, leaves the box alone", async ({ page }) => {
  await fakeRecognition(page, "denied");
  const calls = countActions(page);
  await page.goto("/app/studio");
  await box(page).fill("typed by hand");
  await page.getByRole("button", { name: "Speak instead" }).click();
  const blocked = "Microphone access was blocked. Allow it in your browser's site settings, or type instead.";
  await expect(page.getByTestId("voice-input").getByText(blocked).last()).toBeVisible();
  await expect(status(page)).toHaveText(blocked); // announced
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(box(page)).toHaveValue("typed by hand");

  // allowed now: Retry starts listening again
  await page.evaluate(() => { window.__voice.mode = "ok"; });
  await retry.click();
  await expect(status(page)).toContainText("Listening");
  expect(await page.evaluate(() => window.__voice.starts)).toBe(2);
  expect(calls.actions).toBe(0);
});

test("Safari with Dictation off (service-not-allowed): a clear message and Retry", async ({ page }) => {
  await fakeRecognition(page, "dictation-off");
  await page.goto("/app/studio");
  await page.getByRole("button", { name: "Speak instead" }).click();
  await expect(status(page)).toContainText("Turn on Dictation in your device settings, or type instead.");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("microphone already blocked for the site: said up front, no dead button; re-checked on focus", async ({ page }) => {
  await fakeRecognition(page);
  await micPermission(page, "denied");
  await page.goto("/app/studio");
  await expect(page.getByTestId("voice-blocked")).toContainText("Microphone access is blocked for this site");
  await expect(page.getByRole("button", { name: "Speak instead" })).toHaveCount(0);
  // the person allows it in the site settings and comes back to the page
  await page.evaluate(() => {
    window.__perm!.state = "granted";
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("button", { name: "Speak instead" })).toBeVisible();
  await expect(page.getByTestId("voice-blocked")).toHaveCount(0);
});

test("keyboard: the mic is reachable and toggles with Enter; focus returns to the box", async ({ page }) => {
  await fakeRecognition(page);
  await page.goto("/app/studio");
  await box(page).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Speak instead" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeFocused();
  await last(page).emit([["by keyboard", true]]);
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveValue("By keyboard.");
  await expect(box(page)).toBeFocused();
});

test("unsupported browser: a hint, no mic button", async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) {
      try { delete (window as unknown as Record<string, unknown>)[k]; } catch { /* not configurable */ }
      Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
    }
  });
  await page.goto("/app/studio");
  await expect(page.getByRole("button", { name: "Fill details with AI", exact: true })).toBeVisible();
  await expect(page.getByText("Voice input isn't supported in this browser — type instead.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Speak instead" })).toHaveCount(0);
});

test("insecure page (http, or an http iframe): treated as unsupported", async ({ page }) => {
  await fakeRecognition(page);
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false, configurable: true }));
  await page.goto("/app/studio");
  await expect(page.getByText("Voice input isn't supported in this browser — type instead.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Speak instead" })).toHaveCount(0);
});
