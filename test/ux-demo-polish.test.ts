// Demo polish: how AI-off results are labelled, the file page's status poller, the ask box keeping a question
// after an error, the pending submit button and requests that can't hang.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { linesFromText } from "@/lib/understand/text";
import { answerFromPassages, answerWithModel, QA_STATUS_LABEL } from "@/lib/qa/answer";
import type { ModelProvider } from "@/lib/understand/model";
import { PASSAGES_LABEL, qaPresentation } from "@/components/qaPresentation";
import { isLiveStatus, startPolling } from "@/components/poll";
import { fetchJson, OFFLINE_MESSAGE, TIMEOUT_MESSAGE } from "@/components/fetchTimeout";

const form = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), useFormStatus: () => ({ pending: form.pending, data: null, method: null, action: null }) }));

const nav = vi.hoisted(() => ({ to: "" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    nav.to = url;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/auth", () => ({ requireSession: async () => ({ workspaceId: "ws_1", userId: "u_1", userEmail: "avery@example.com" }) }));
const asked = vi.hoisted(() => ({ fail: null as null | { message: string; status: number } }));
vi.mock("@/lib/files", async () => {
  const { AppError } = await import("@/lib/errors");
  return { AppError };
});
vi.mock("@/lib/qa/store", async () => {
  const { AppError } = await import("@/lib/errors");
  return {
    askQuestion: async () => {
      if (asked.fail) throw new AppError(asked.fail.message, asked.fail.status);
      return "qa_123";
    },
  };
});

const PAGES = linesFromText([
  `SERVICES AGREEMENT
This Agreement is made between Example Studio LLC ("Provider") and Sample Client Inc. ("Client").
1. Fees. The Client will pay a fee of $2,000 per month. Invoices are payable within 15 days of receipt.
2. Term. This Agreement remains in effect for 12 months.`,
  `3. Termination. Either party may terminate this Agreement on 30 days' written notice.`,
]);

describe("AI-off results are labelled as passages, not as a partial answer", () => {
  it("passages mode keeps its status (no safety change) but shows a neutral 'Relevant passages' badge", () => {
    const r = answerFromPassages("How much are the fees?", PAGES);
    expect(r.mode).toBe("passages");
    expect(r.status).toBe("partial");
    const shown = qaPresentation(r);
    expect(shown.badge).toEqual({ label: PASSAGES_LABEL, tone: "neutral" });
    expect(shown.badge.label).not.toBe(QA_STATUS_LABEL.partial);
    expect(shown.how).toBe("Passages, no AI model");
  });
  it("'not found' stays 'not found' without a model", () => {
    const r = answerFromPassages("What is the warranty period for the hardware?", PAGES);
    expect(r.status).toBe("not_found");
    expect(qaPresentation(r).badge).toEqual({ label: QA_STATUS_LABEL.not_found, tone: "neutral" });
  });
  it("model answers keep their status labels and tones", async () => {
    const provider: ModelProvider = { name: "stub", model: "stub-1", async complete() { throw new Error("unused"); } } as unknown as ModelProvider;
    for (const [status, tone] of [["answered", "ok"], ["partial", "warn"], ["not_found", "neutral"]] as const)
      expect(qaPresentation({ status, mode: "model", model: "stub-1" })).toEqual({ badge: { label: QA_STATUS_LABEL[status], tone }, how: "AI assistant (stub-1)" });
    // a real model-mode result with nothing relevant (no call made) is labelled from its own status
    const r = await answerWithModel(provider, "What is the warranty period for the hardware?", PAGES);
    expect(qaPresentation(r).badge.label).toBe(QA_STATUS_LABEL.not_found);
  });
});

describe("file status poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const fakeDoc = (state: DocumentVisibilityState) => {
    const t = new EventTarget();
    const doc = { visibilityState: state, addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t) };
    const set = (s: DocumentVisibilityState) => {
      doc.visibilityState = s;
      t.dispatchEvent(new Event("visibilitychange"));
    };
    return { doc: doc as unknown as Document, set };
  };

  it("refreshes every interval while visible, and stops when told to", () => {
    const tick = vi.fn();
    const { doc } = fakeDoc("visible");
    const stop = startPolling(tick, 5000, doc);
    vi.advanceTimersByTime(4999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
  it("pauses while the tab is hidden, catches up once when it's shown again", () => {
    const tick = vi.fn();
    const { doc, set } = fakeDoc("visible");
    const stop = startPolling(tick, 5000, doc);
    set("hidden");
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(0);
    set("visible");
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
    set("visible");
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
  it("doesn't start in a hidden tab", () => {
    const tick = vi.fn();
    const { doc } = fakeDoc("hidden");
    startPolling(tick, 5000, doc);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
  });
  it("polls only while the file waits on someone", () => {
    for (const s of ["sent", "viewed", "signed"]) expect(isLiveStatus(s)).toBe(true);
    for (const s of ["draft", "completed", "declined", "voided", "expired"]) expect(isLiveStatus(s)).toBe(false);
  });
});

describe("the ask box keeps a question after an error", () => {
  const fd = (question: string) => {
    const f = new FormData();
    f.set("versionId", "tv_1");
    f.set("question", question);
    return f;
  };
  it("an error redirect carries the question back", async () => {
    const { askAction } = await import("@/app/qa-actions");
    asked.fail = { message: "You're asking quickly. Wait a minute and try again.", status: 429 };
    await expect(askAction(fd("Can the client end it early & pay less?"))).rejects.toThrow("NEXT_REDIRECT");
    const u = new URL(nav.to, "http://x");
    expect(u.pathname).toBe("/app/agreements/tv_1/ask");
    expect(u.searchParams.get("error")).toBe("slow");
    expect(u.searchParams.get("q")).toBe("Can the client end it early & pay less?");
  });
  it("caps the question at the box's 500 characters, and leaves out an empty one", async () => {
    const { askAction } = await import("@/app/qa-actions");
    asked.fail = { message: "Ask a question of up to 500 characters.", status: 422 };
    await expect(askAction(fd("a".repeat(1500)))).rejects.toThrow("NEXT_REDIRECT");
    expect(new URL(nav.to, "http://x").searchParams.get("q")).toBe("a".repeat(500));
    await expect(askAction(fd("   "))).rejects.toThrow("NEXT_REDIRECT");
    expect(new URL(nav.to, "http://x").searchParams.has("q")).toBe(false);
  });
  it("success doesn't put the question in the URL", async () => {
    const { askAction } = await import("@/app/qa-actions");
    asked.fail = null;
    await expect(askAction(fd("What are the payment terms?"))).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.to).toBe("/app/agreements/tv_1/ask?asked=qa_123");
  });
});

describe("pending-aware submit button", () => {
  it("is a normal submit button when idle", async () => {
    const { SubmitButton } = await import("@/components/ui");
    form.pending = false;
    const html = renderToStaticMarkup(createElement(SubmitButton, { icon: "spark", pendingLabel: "Reading…" }, "Read this agreement"));
    expect(html).toMatch(/^<button[^>]*type="submit"/);
    expect(html).not.toMatch(/ disabled=""|aria-busy=/);
    expect(html).toContain("Read this agreement");
  });
  it("disables itself with a spinner and its pending label while the form submits", async () => {
    const { SubmitButton } = await import("@/components/ui");
    form.pending = true;
    const html = renderToStaticMarkup(createElement(SubmitButton, { icon: "spark", pendingLabel: "Reading…" }, "Read this agreement"));
    expect(html).toMatch(/ disabled=""/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    expect(html).toContain("Reading…");
    expect(html).not.toContain("Read this agreement");
    // without a pending label the name stays the same (so it's still found by its name)
    expect(renderToStaticMarkup(createElement(SubmitButton, { variant: "secondary" }, "Edit fields"))).toContain("Edit fields");
    form.pending = false;
  });
});

describe("client requests that can hang", () => {
  it("a request that never answers times out with a retryable message", async () => {
    const hang: typeof fetch = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const r = await fetchJson("/api/agreements/sample", { method: "POST" }, { timeoutMs: 20, fetchImpl: hang });
    expect(r).toMatchObject({ ok: false, timedOut: true, status: null, error: TIMEOUT_MESSAGE });
  });
  it("no connection, an error status and a success", async () => {
    const offline: typeof fetch = async () => { throw new TypeError("Failed to fetch"); };
    expect(await fetchJson("/x", {}, { fetchImpl: offline })).toMatchObject({ ok: false, timedOut: false, error: OFFLINE_MESSAGE });
    const err: typeof fetch = async () => new Response(JSON.stringify({ error: "Not allowed" }), { status: 403 });
    expect(await fetchJson("/x", {}, { fetchImpl: err })).toMatchObject({ ok: false, status: 403, error: "Not allowed" });
    const html: typeof fetch = async () => new Response("<html>", { status: 502 });
    expect(await fetchJson("/x", {}, { fetchImpl: html })).toMatchObject({ ok: false, status: 502, error: "The request failed (502). Try again." });
    const ok: typeof fetch = async () => new Response(JSON.stringify({ versionId: "tv_9" }), { status: 200 });
    expect(await fetchJson<{ versionId: string }>("/x", {}, { fetchImpl: ok })).toEqual({ ok: true, status: 200, data: { versionId: "tv_9" } });
  });
});
