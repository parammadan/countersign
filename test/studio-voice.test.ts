// Voice input in the Studio AI panel: speech becomes text added to the description box, for the person to check.
// The pure parts (state, transcript merge, results), the session controller against a fake recognition (no browser,
// no microphone), the copy, and the server-rendered markup (nothing voice-related until the client checks support).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/app/studio-actions", () => ({ suggestAction: vi.fn(), createDraftAction: vi.fn() }));

import { suggestAction, createDraftAction } from "@/app/studio-actions";
import { NewAgreement } from "@/components/studio/NewAgreement";
import { VoicePanel } from "@/components/studio/VoiceInput";
import { AI_COPY, VOICE_COPY } from "@/components/studio/ai-state";
import {
  VOICE_IDLE, clock, mergeTranscript, readResults, recognitionCtor, startVoiceSession, voiceError, voiceReducer,
  type RecognitionLike, type RecognitionResultList, type VoiceAction, type VoiceState,
} from "@/components/studio/voice-state";
import type { KindSpec, StudioAi } from "@/lib/drafts/service";

const esc = (s: string) => s.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const res = (...r: [string, boolean][]): RecognitionResultList => r.map(([t, isFinal]) => ({ isFinal, length: 1, 0: { transcript: t } }));

describe("mergeTranscript: adds after what's typed, never replaces it, and fits the box", () => {
  it("appends with one space, or none after a space or line break", () => {
    expect(mergeTranscript("", "consulting agreement", 4000)).toEqual({ text: "consulting agreement", truncated: false });
    expect(mergeTranscript("Acme Inc.", "and Northwind LLC", 4000).text).toBe("Acme Inc. and Northwind LLC");
    expect(mergeTranscript("Acme Inc. ", "and Northwind", 4000).text).toBe("Acme Inc. and Northwind");
    expect(mergeTranscript("Line one\n", "line two", 4000).text).toBe("Line one\nline two");
  });
  it("keeps the typed text exactly, and ignores empty speech", () => {
    const typed = "  I typed this  carefully";
    expect(mergeTranscript(typed, "   ", 4000)).toEqual({ text: typed, truncated: false });
    expect(mergeTranscript(typed, "more", 4000).text.startsWith(typed)).toBe(true);
  });
  it("collapses runs of whitespace in the speech", () => {
    expect(mergeTranscript("", "  fee   of\n$12,000 ", 4000).text).toBe("fee of $12,000");
  });
  it("cuts to the maximum length and says so", () => {
    const r = mergeTranscript("x".repeat(3990), "a consulting agreement", 4000);
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.text).toBe(`${"x".repeat(3990)} a consult`);
    expect(r.truncated).toBe(true);
  });
  it("a full box stays as it is, marked truncated", () => {
    const full = "y".repeat(4000);
    expect(mergeTranscript(full, "anything", 4000)).toEqual({ text: full, truncated: true });
    expect(mergeTranscript("y".repeat(3999), "anything", 4000)).toEqual({ text: "y".repeat(3999), truncated: true }); // only room for the space
  });
  it("doesn't split an emoji at the cut", () => {
    const r = mergeTranscript("a".repeat(3995), "ok 😀", 4000); // room for "ok " and half the emoji
    expect(r.text).toBe(`${"a".repeat(3995)} ok`);
    expect(r.text.length).toBeLessThanOrEqual(4000);
  });
});

describe("readResults: final vs interim", () => {
  it("separates final and interim text across the session's results", () => {
    expect(readResults(res(["I need a consulting", true], [" agreement between", false]))).toEqual({ final: "I need a consulting", interim: "agreement between" });
    expect(readResults(res(["one", true], ["two", true]))).toEqual({ final: "one two", interim: "" });
    expect(readResults([])).toEqual({ final: "", interim: "" });
    expect(readResults([{ isFinal: true, length: 0 } as never])).toEqual({ final: "", interim: "" });
  });
});

describe("voiceReducer", () => {
  const run = (...as: VoiceAction[]) => as.reduce(voiceReducer, VOICE_IDLE);
  it("idle → requesting → listening → heard → processing → done", () => {
    let s = run({ type: "request" });
    expect(s.status).toBe("requesting");
    s = voiceReducer(s, { type: "listening", at: 1000 });
    expect(s).toMatchObject({ status: "listening", startedAt: 1000 });
    s = voiceReducer(s, { type: "heard", text: "hello" });
    expect(s.heard).toBe("hello");
    s = voiceReducer(s, { type: "processing" });
    expect(s.status).toBe("processing");
    s = voiceReducer(s, { type: "done", truncated: true, autoStopped: false });
    expect(s).toMatchObject({ status: "done", heard: "", truncated: true, startedAt: null });
  });
  it("errors clear what was heard; a new request starts clean", () => {
    const s = run({ type: "request" }, { type: "listening", at: 1 }, { type: "heard", text: "x" }, { type: "error", code: "network" });
    expect(s).toMatchObject({ status: "error", error: "network", heard: "" });
    expect(voiceReducer(s, { type: "request" })).toEqual({ ...VOICE_IDLE, status: "requesting" });
    expect(voiceReducer(s, { type: "reset" })).toEqual(VOICE_IDLE);
  });
  it("ignores late events that don't fit the state", () => {
    expect(run({ type: "heard", text: "late" })).toEqual(VOICE_IDLE);
    expect(run({ type: "listening", at: 5 })).toEqual(VOICE_IDLE);
    expect(run({ type: "processing" })).toEqual(VOICE_IDLE);
  });
  it("maps the browser's error codes", () => {
    expect(voiceError("not-allowed")).toBe("not-allowed");
    expect(voiceError("service-not-allowed")).toBe("not-allowed");
    for (const c of ["no-speech", "audio-capture", "network", "aborted"] as const) expect(voiceError(c)).toBe(c);
    expect(voiceError("language-not-supported")).toBe("other");
    expect(voiceError(undefined)).toBe("other");
    expect(clock(7_400)).toBe("0:07");
    expect(clock(60_000)).toBe("1:00");
  });
});

describe("recognitionCtor: feature-detected, never assumed", () => {
  it("finds the standard or prefixed constructor, or nothing", () => {
    class R {}
    expect(recognitionCtor(undefined)).toBeNull();
    expect(recognitionCtor({})).toBeNull();
    expect(recognitionCtor({ SpeechRecognition: R })).toBe(R);
    expect(recognitionCtor({ webkitSpeechRecognition: R })).toBe(R);
    expect(recognitionCtor({ SpeechRecognition: "nope" })).toBeNull();
    expect(recognitionCtor()).toBeNull(); // node: no window
  });
});

// a scripted stand-in for the browser's recognition
class Fake implements RecognitionLike {
  static last: Fake | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: RecognitionLike["onstart"] = null;
  onaudiostart: RecognitionLike["onaudiostart"] = null;
  onresult: RecognitionLike["onresult"] = null;
  onspeechend: RecognitionLike["onspeechend"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() { Fake.last = this; }
  start() { this.started++; }
  stop() { this.stopped++; this.onend?.({}); }
  abort() { this.aborted++; }
}

function session(initial = "", max = 4000) {
  let box = initial;
  const states: VoiceState[] = [];
  let st = VOICE_IDLE;
  const s = startVoiceSession(Fake, {
    lang: "en-GB",
    dispatch: (a) => { st = voiceReducer(st, a); states.push(st); },
    append: (t) => { const r = mergeTranscript(box, t, max); box = r.text; return r.truncated; },
    maxMs: 60_000,
    now: () => 1000,
  });
  return { s, rec: Fake.last!, box: () => box, state: () => st, states };
}

describe("startVoiceSession: shows interim text live, adds final text once at the end, nothing else", () => {
  beforeEach(() => { vi.mocked(suggestAction).mockClear(); vi.mocked(createDraftAction).mockClear(); });
  afterEach(() => {
    vi.useRealTimers();
    // the voice flows never ask Claude or create anything
    expect(suggestAction).not.toHaveBeenCalled();
    expect(createDraftAction).not.toHaveBeenCalled();
  });

  it("configures the recognition (language, continuous, interim results)", () => {
    const { rec } = session();
    expect(rec).toMatchObject({ lang: "en-GB", continuous: true, interimResults: true, maxAlternatives: 1, started: 1 });
  });
  it("interim shows while listening without touching the box; the final text is appended on end", () => {
    const t = session("Typed first.");
    expect(t.state().status).toBe("requesting");
    t.rec.onstart?.({});
    expect(t.state()).toMatchObject({ status: "listening", startedAt: 1000 });
    t.rec.onresult?.({ results: res(["a consulting", false]) });
    expect(t.state().heard).toBe("a consulting");
    expect(t.box()).toBe("Typed first."); // interim never goes in the box
    t.rec.onresult?.({ results: res(["A consulting agreement", true], ["for twelve", false]) });
    expect(t.state().heard).toBe("A consulting agreement for twelve");
    t.rec.onresult?.({ results: res(["A consulting agreement", true], ["for $12,000", true]) });
    t.rec.onspeechend?.({}); // silence: stops, which ends the session
    expect(t.rec.stopped).toBe(1);
    expect(t.box()).toBe("Typed first. A consulting agreement for $12,000");
    expect(t.state()).toMatchObject({ status: "done", truncated: false, autoStopped: false });
    expect(t.states.map((x) => x.status)).toContain("processing");
  });
  it("a stopped session keeps unfinalised words; a later end event doesn't add them twice", () => {
    const t = session();
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["between Acme", false]) });
    t.s.stop();
    t.rec.onend?.({});
    expect(t.box()).toBe("between Acme");
  });
  it("stops itself after 60 seconds", () => {
    vi.useFakeTimers();
    const t = session();
    t.rec.onaudiostart?.({});
    t.rec.onresult?.({ results: res(["long dictation", true]) });
    vi.advanceTimersByTime(59_999);
    expect(t.rec.stopped).toBe(0);
    vi.advanceTimersByTime(1);
    expect(t.rec.stopped).toBe(1);
    expect(t.state()).toMatchObject({ status: "done", autoStopped: true });
    expect(t.box()).toBe("long dictation");
  });
  it("too long for the box: cut, and the state says so", () => {
    const t = session("z".repeat(3994));
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["one two three", true]) });
    t.s.stop();
    expect(t.box()).toBe(`${"z".repeat(3994)} one t`); // cut at the limit
    expect(t.state()).toMatchObject({ status: "done", truncated: true });
  });
  for (const code of ["not-allowed", "no-speech", "audio-capture", "network", "aborted"] as const) {
    it(`${code}: an error state, and the box is untouched`, () => {
      const t = session("mine");
      t.rec.onresult?.({ results: res(["half", true]) });
      t.rec.onerror?.({ error: code });
      t.rec.onend?.({});
      expect(t.state()).toMatchObject({ status: "error", error: code });
      expect(t.box()).toBe("mine");
    });
  }
  it("ending with nothing heard is no-speech; stopping before the microphone opened goes back to idle", () => {
    const a = session();
    a.rec.onstart?.({});
    a.rec.onend?.({});
    expect(a.state()).toMatchObject({ status: "error", error: "no-speech" });
    const b = session();
    b.s.stop();
    expect(b.state()).toEqual(VOICE_IDLE);
  });
  it("abort (unmount, leaving the page) ends silently: no text added, handlers detached", () => {
    const t = session("mine");
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["something", true]) });
    const before = t.states.length;
    t.s.abort();
    expect(t.rec.aborted).toBe(1);
    expect(t.rec.onresult).toBeNull();
    expect(t.rec.onend).toBeNull();
    expect(t.box()).toBe("mine");
    expect(t.states.length).toBe(before);
  });
  it("a recognition that throws on start is an error, not a crash", () => {
    class Throws extends Fake { start(): void { throw new Error("InvalidStateError"); } }
    let st = VOICE_IDLE;
    startVoiceSession(Throws, { lang: "en-US", dispatch: (a) => { st = voiceReducer(st, a); }, append: () => false });
    expect(st).toMatchObject({ status: "error", error: "other" });
  });
});

describe("copy", () => {
  it("is the fixed, honest text", () => {
    expect(VOICE_COPY.start).toBe("Speak instead");
    expect(VOICE_COPY.stop).toBe("Stop");
    expect(VOICE_COPY.done).toBe("Added to the box above — check it, then press Fill details with AI");
    expect(VOICE_COPY.done).toContain(AI_COPY.button);
    expect(VOICE_COPY.errors["not-allowed"]).toBe("Microphone access was blocked. Allow it in your browser's site settings, or type instead.");
    expect(VOICE_COPY.privacy).toBe("Your browser's speech service turns speech into text; AgreementOS receives only the text you send.");
    expect(VOICE_COPY.unsupported).toBe("Voice input isn't supported in this browser — type instead.");
    expect(VOICE_COPY.truncated).toMatch(/4,000 characters/);
    for (const t of Object.values(VOICE_COPY.errors)) expect(t).toMatch(/type instead\.$/);
  });
});

describe("server-rendered markup", () => {
  const kinds: KindSpec[] = [{ kind: "nda", title: "Mutual NDA", roles: ["Disclosing Party", "Receiving Party"], terms: [{ key: "startDate", type: "date", required: true }] }];
  const on = { available: true } as const;
  const ai: StudioAi = { suggest: on, draft: on };
  const g = globalThis as { window?: unknown };
  afterEach(() => { delete g.window; });

  it("no mic and no hint until the client has checked support (so hydration matches)", () => {
    const plain = renderToString(createElement(NewAgreement, { kinds, ai }));
    // even with a recognition present, the server snapshot is used: the same markup either way
    g.window = { SpeechRecognition: class {} };
    const withApi = renderToString(createElement(NewAgreement, { kinds, ai }));
    expect(withApi).toBe(plain);
    for (const h of [plain, withApi]) {
      expect(h).not.toContain(VOICE_COPY.start);
      expect(h).not.toContain(esc(VOICE_COPY.unsupported));
      expect(h).toContain(AI_COPY.button); // the rest of the panel is unchanged
      expect(h).toContain(AI_COPY.exampleButton);
    }
  });
  it("without AI suggestions, no voice control at all", () => {
    const h = renderToStaticMarkup(createElement(NewAgreement, { kinds, ai: { suggest: { available: false, reason: "off" }, draft: { available: false, reason: "off" } } }));
    expect(h).not.toContain(VOICE_COPY.start);
    expect(h).not.toContain("voice-");
  });

  const panel = (support: "unknown" | "supported" | "unsupported", state: VoiceState, elapsed = 0) =>
    renderToStaticMarkup(createElement(VoicePanel, { support, state, elapsed, onStart: () => {}, onStop: () => {} }));
  it("unsupported: a hint, no dead button", () => {
    const h = panel("unsupported", VOICE_IDLE);
    expect(h).toContain(esc(VOICE_COPY.unsupported));
    expect(h).not.toContain("<button");
    expect(panel("unknown", VOICE_IDLE)).toBe("");
  });
  it("idle: the toggle (not pressed), the privacy note and a live status region", () => {
    const h = panel("supported", VOICE_IDLE);
    expect(h).toContain(VOICE_COPY.start);
    expect(h).toContain('aria-pressed="false"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain(esc(VOICE_COPY.privacy));
  });
  it("listening: pressed, Stop, elapsed time, the words heard", () => {
    const h = panel("supported", { ...VOICE_IDLE, status: "listening", startedAt: 1, heard: "a consulting agreement" }, 12_000);
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain(">Stop<");
    expect(h).toContain("0:12 of 1:00");
    expect(h).toContain("a consulting agreement");
  });
  it("done and error states", () => {
    const done = panel("supported", { ...VOICE_IDLE, status: "done", truncated: true, autoStopped: true });
    expect(done).toContain(VOICE_COPY.done);
    expect(done).toContain(esc(VOICE_COPY.truncated));
    expect(done).toContain(VOICE_COPY.autoStopped);
    for (const code of Object.keys(VOICE_COPY.errors) as (keyof typeof VOICE_COPY.errors)[]) {
      const h = panel("supported", { ...VOICE_IDLE, status: "error", error: code });
      expect(h).toContain(esc(VOICE_COPY.errors[code]));
      expect(h).toContain(`>${VOICE_COPY.retry}<`);
    }
  });
});
