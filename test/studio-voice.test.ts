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
import { VoicePanel, focusAtEnd } from "@/components/studio/VoiceInput";
import { AI_COPY, VOICE_COPY } from "@/components/studio/ai-state";
import {
  VOICE_IDLE, VOICE_START_GRACE_MS, VOICE_STOP_GRACE_MS, clock, joinFinals, mergeTranscript, micPermission, readResults, recognitionCtor, startVoiceSession, tidyChunk, voiceBusy, voiceError, voiceReducer,
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
    expect(readResults(res(["I need a consulting", true], [" agreement between", false]))).toMatchObject({ final: "I need a consulting", interim: "agreement between" });
    expect(readResults(res(["one", true], ["two", true]))).toEqual({ finals: ["one", "two"], final: "one two", interim: "" });
    expect(readResults([])).toEqual({ finals: [], final: "", interim: "" });
    expect(readResults([{ isFinal: true, length: 0 } as never])).toMatchObject({ final: "", interim: "" });
  });
  it("Chrome: many result events over one growing list (resultIndex moves on) lose and duplicate nothing", () => {
    const events = [
      res(["i need a", false]),
      res(["i need a consulting agreement", true]),
      res(["i need a consulting agreement", true], ["between acme", false]),
      res(["i need a consulting agreement", true], ["between acme and northwind", true]),
      res(["i need a consulting agreement", true], ["between acme and northwind", true], ["for $12,000", false]),
    ];
    const seen = events.map(readResults);
    expect(seen[4]).toEqual({ finals: ["i need a consulting agreement", "between acme and northwind"], final: "i need a consulting agreement between acme and northwind", interim: "for $12,000" });
  });
  it("Chrome on Android: each growing phrase reported as its own final result is counted once", () => {
    expect(readResults(res(["the fee", true], ["the fee is", true], ["the fee is $5,000", true])).final).toBe("the fee is $5,000");
    expect(joinFinals(["Acme", "acme", "and Northwind"])).toEqual(["Acme", "and Northwind"]);
    expect(joinFinals(["start in January", "January"])).toEqual(["start in January", "January"]); // a word said again stays
    expect(joinFinals(["one", " ", "two"])).toEqual(["one", "two"]);
  });
});

describe("tidyChunk: capital first letter, a full stop only where punctuation is missing, nothing else changed", () => {
  it("capitalises and ends a bare chunk", () => {
    expect(tidyChunk("i need a consulting agreement")).toBe("I need a consulting agreement.");
    expect(tidyChunk("  between acme and northwind  ")).toBe("Between acme and northwind.");
  });
  it("leaves punctuation that's there", () => {
    expect(tidyChunk("is that all?")).toBe("Is that all?");
    expect(tidyChunk("Delaware law applies.")).toBe("Delaware law applies.");
    expect(tidyChunk("terms: net 30,")).toBe("Terms: net 30,");
    expect(tidyChunk('"Acme"')).toBe('"Acme"');
  });
  it("never changes digits, amounts or names", () => {
    expect(tidyChunk("$12,000 per month")).toBe("$12,000 per month.");
    expect(tidyChunk("for 12000")).toBe("For 12000.");
    expect(tidyChunk("McDonald's and iPhone LLC")).toBe("McDonald's and iPhone LLC.");
    expect(tidyChunk("eBay inc")).toBe("EBay inc."); // only the first letter, as asked
    expect(tidyChunk("30%")).toBe("30%");
    expect(tidyChunk("")).toBe("");
  });
  it("other scripts: no stray full stop where the language doesn't use one", () => {
    expect(tidyChunk("咨询协议", "zh-CN")).toBe("咨询协议");
    expect(tidyChunk("договор", "ru-RU")).toBe("Договор.");
    expect(tidyChunk("élan", "fr-FR")).toBe("Élan.");
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
    // Safari with Siri / Dictation off: its own message, not the site-permission one
    expect(voiceError("service-not-allowed")).toBe("service-not-allowed");
    expect(voiceError("language-not-supported")).toBe("language-not-supported");
    for (const c of ["no-speech", "audio-capture", "network", "aborted"] as const) expect(voiceError(c)).toBe(c);
    expect(voiceError("bad-grammar")).toBe("other");
    expect(voiceError(undefined)).toBe("other");
    expect(micPermission("denied")).toBe("denied");
    expect(micPermission("granted")).toBe("granted");
    expect(micPermission("prompt")).toBe("prompt");
    expect(micPermission(undefined)).toBe("unknown");
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
    // recognition needs https: an insecure page (or an http iframe) counts as unsupported
    expect(recognitionCtor({ webkitSpeechRecognition: R, isSecureContext: false })).toBeNull();
    expect(recognitionCtor({ webkitSpeechRecognition: R, isSecureContext: true })).toBe(R);
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
  static all: Fake[] = [];
  constructor() { Fake.last = this; Fake.all.push(this); }
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
  it("interim shows while listening without touching the box; the final text, tidied, is appended on end", () => {
    const t = session("Typed first.");
    expect(t.state().status).toBe("requesting");
    t.rec.onstart?.({});
    expect(t.state()).toMatchObject({ status: "listening", startedAt: 1000 });
    t.rec.onresult?.({ results: res(["a consulting", false]) });
    expect(t.state().heard).toBe("a consulting");
    expect(t.box()).toBe("Typed first."); // interim never goes in the box
    t.rec.onresult?.({ results: res(["A consulting agreement", true], ["for twelve", false]) });
    expect(t.state().heard).toBe("A consulting agreement for twelve");
    t.rec.onresult?.({ results: res(["A consulting agreement for $12,000", true]) });
    t.rec.onspeechend?.({}); // a pause doesn't end a dictation (continuous)
    expect(t.rec.stopped).toBe(0);
    t.s.stop();
    expect(t.rec.stopped).toBe(1);
    expect(t.box()).toBe("Typed first. A consulting agreement for $12,000.");
    expect(t.state()).toMatchObject({ status: "done", truncated: false, autoStopped: false });
    expect(t.states.map((x) => x.status)).toContain("processing");
  });
  it("a stopped session keeps unfinalised words; a later end event doesn't add them twice", () => {
    const t = session();
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["between Acme", false]) });
    t.s.stop();
    t.rec.onend?.({});
    expect(t.box()).toBe("Between Acme.");
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
    expect(t.box()).toBe("Long dictation.");
  });
  it("too long for the box: cut, and the state says so", () => {
    const t = session("z".repeat(3994));
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["one two three", true]) });
    t.s.stop();
    expect(t.box()).toBe(`${"z".repeat(3994)} One t`); // cut at the limit
    expect(t.state()).toMatchObject({ status: "done", truncated: true });
  });
  for (const code of ["not-allowed", "service-not-allowed", "language-not-supported", "audio-capture", "network"] as const) {
    it(`${code}: an error state, and the box is untouched`, () => {
      const t = session("mine");
      t.rec.onresult?.({ results: res(["half", true]) });
      t.rec.onerror?.({ error: code });
      t.rec.onend?.({});
      expect(t.state()).toMatchObject({ status: "error", error: code });
      expect(t.box()).toBe("mine");
    });
  }
  for (const code of ["no-speech", "aborted"] as const) {
    it(`${code} after something was heard keeps it; with nothing heard it's an error`, () => {
      const t = session("mine");
      t.rec.onresult?.({ results: res(["half", true]) });
      t.rec.onerror?.({ error: code });
      t.rec.onend?.({});
      expect(t.state().status).toBe("done");
      expect(t.box()).toBe("mine Half.");
      const u = session("mine");
      u.rec.onstart?.({});
      u.rec.onerror?.({ error: code });
      u.rec.onend?.({});
      expect(u.state()).toMatchObject({ status: "error", error: code });
      expect(u.box()).toBe("mine");
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
  it("a browser that never ends the session after Stop: ended after the grace period, keeping what was heard", () => {
    vi.useFakeTimers();
    class NoEnd extends Fake { stop() { this.stopped++; } abort() { this.aborted++; } }
    let box = "Typed.";
    let st = VOICE_IDLE;
    const s = startVoiceSession(NoEnd, { lang: "en-US", dispatch: (a) => { st = voiceReducer(st, a); }, append: (t) => { const r = mergeTranscript(box, t, 4000); box = r.text; return r.truncated; } });
    const rec = Fake.last!;
    rec.onstart?.({});
    rec.onresult?.({ results: res(["Acme Inc", true], ["and Northwind", false]) });
    s.stop();
    expect(st.status).toBe("processing");
    vi.advanceTimersByTime(VOICE_STOP_GRACE_MS - 1);
    expect(st.status).toBe("processing");
    expect(rec.aborted).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rec.aborted).toBe(1);
    expect(rec.onend).toBeNull(); // a late end event can't add it twice
    expect(st).toMatchObject({ status: "done" });
    expect(box).toBe("Typed. Acme Inc. And Northwind.");
    vi.advanceTimersByTime(120_000); // the 60-second timer was cleared too
    expect(box).toBe("Typed. Acme Inc. And Northwind.");
  });
  it("the grace timer is cleared when the browser does end the session", () => {
    vi.useFakeTimers();
    const t = session();
    t.rec.onstart?.({});
    t.rec.onresult?.({ results: res(["fine", true]) });
    t.s.stop();
    expect(t.state().status).toBe("done");
    vi.advanceTimersByTime(VOICE_STOP_GRACE_MS * 2);
    expect(t.rec.aborted).toBe(0);
    expect(t.box()).toBe("Fine.");
  });
  it("Safari: a run that ends by itself after a phrase is started again, and nothing heard is lost or doubled", () => {
    const t = session("Typed.");
    const first = t.rec;
    first.onstart?.({});
    // Safari often never marks results final before ending the run
    first.onresult?.({ results: res(["i need a consulting agreement", false]) });
    first.onend?.({});
    expect(t.state().status).toBe("listening"); // not done: listening again
    const second = Fake.last!;
    expect(second).not.toBe(first);
    expect(second.started).toBe(1);
    expect(first.onresult).toBeNull(); // the old run can't add anything later
    second.onstart?.({}); // a new run going live doesn't restart the clock or the state
    second.onresult?.({ results: res(["between acme and northwind", true]) });
    expect(t.state().heard).toBe("i need a consulting agreement between acme and northwind");
    second.onend?.({});
    const third = Fake.last!;
    expect(third).not.toBe(second);
    // the third run hears nothing: silence ends the dictation
    third.onend?.({});
    expect(t.state().status).toBe("done");
    expect(t.box()).toBe("Typed. I need a consulting agreement. Between acme and northwind.");
    expect(t.box().match(/consulting/g)).toHaveLength(1);
  });
  it("restarts are capped, and never past the 60 seconds", () => {
    let clock_ = 0;
    let st = VOICE_IDLE;
    let box = "";
    const before = Fake.all.length;
    startVoiceSession(Fake, { lang: "en-US", maxRestarts: 2, now: () => clock_, dispatch: (a) => { st = voiceReducer(st, a); }, append: (x) => { box = mergeTranscript(box, x, 4000).text; return false; } });
    for (let i = 0; i < 5 && st.status !== "done"; i++) {
      Fake.last!.onstart?.({});
      Fake.last!.onresult?.({ results: res([`phrase ${i}`, true]) });
      Fake.last!.onend?.({});
    }
    expect(Fake.all.length - before).toBe(3); // the first run and 2 restarts
    expect(box).toBe("Phrase 0. Phrase 1. Phrase 2.");
    // past the limit: no restart even under the cap
    st = VOICE_IDLE;
    box = "";
    const n = Fake.all.length;
    startVoiceSession(Fake, { lang: "en-US", maxMs: 60_000, now: () => clock_, dispatch: (a) => { st = voiceReducer(st, a); }, append: (x) => { box = mergeTranscript(box, x, 4000).text; return false; } });
    Fake.last!.onstart?.({});
    Fake.last!.onresult?.({ results: res(["late", true]) });
    clock_ += 60_000;
    Fake.last!.onend?.({});
    expect(Fake.all.length - n).toBe(1);
    expect(box).toBe("Late.");
  });
  it("Chrome on Android: no onaudiostart needed, a result alone shows it's listening", () => {
    const t = session();
    t.rec.onresult?.({ results: res(["hello", false]) });
    expect(t.state()).toMatchObject({ status: "listening", heard: "hello" });
  });
  it("a permission prompt dismissed with no event: back to idle after the grace period, nothing added", () => {
    vi.useFakeTimers();
    const t = session("mine");
    vi.advanceTimersByTime(VOICE_START_GRACE_MS - 1);
    expect(t.state().status).toBe("requesting");
    vi.advanceTimersByTime(1);
    expect(t.state()).toEqual(VOICE_IDLE);
    expect(t.rec.aborted).toBe(1);
    expect(t.box()).toBe("mine");
  });
  it("a permission prompt dismissed that just ends the run: back to idle, no error", () => {
    const t = session();
    t.rec.onend?.({});
    expect(t.state()).toEqual(VOICE_IDLE);
  });
  it("the start grace period doesn't cut a session that went live", () => {
    vi.useFakeTimers();
    const t = session();
    t.rec.onstart?.({});
    vi.advanceTimersByTime(VOICE_START_GRACE_MS + 1);
    expect(t.state().status).toBe("listening");
    expect(t.rec.aborted).toBe(0);
  });
  it("busy while requesting, listening or processing (the panel holds off sending the box)", () => {
    expect((["requesting", "listening", "processing"] as const).every(voiceBusy)).toBe(true);
    expect((["idle", "done", "error"] as const).some(voiceBusy)).toBe(false);
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
    expect(VOICE_COPY.privacy).toBe("Your browser may send your voice to its maker's speech service (for example Google, in Chrome) to turn it into text. AgreementOS never receives audio, only the text you choose to send.");
    expect(VOICE_COPY.unsupported).toBe("Voice input isn't supported in this browser — type instead.");
    expect(VOICE_COPY.errors["service-not-allowed"]).toContain("Turn on Dictation in your device settings, or type instead.");
    expect(VOICE_COPY.errors["language-not-supported"]).toMatch(/language/);
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
  it("microphone blocked (the browser says so up front): a message and no button that can only fail", () => {
    const h = renderToStaticMarkup(createElement(VoicePanel, { support: "supported", state: VOICE_IDLE, elapsed: 0, permission: "denied", onStart: () => {}, onStop: () => {} }));
    expect(h).toContain(esc(VOICE_COPY.blocked));
    expect(h).not.toContain("<button");
    for (const p of ["granted", "prompt", "unknown"] as const) {
      const ok = renderToStaticMarkup(createElement(VoicePanel, { support: "supported", state: VOICE_IDLE, elapsed: 0, permission: p, onStart: () => {}, onStop: () => {} }));
      expect(ok).toContain(VOICE_COPY.start);
    }
  });
  it("after text is added, the box gets focus with the cursor at the end", () => {
    const calls: string[] = [];
    const box = { value: "Typed. Added.", scrollHeight: 300, scrollTop: 0, focus: () => calls.push("focus"), setSelectionRange: (a: number, b: number) => calls.push(`sel ${a}-${b}`) };
    focusAtEnd(box as unknown as HTMLTextAreaElement);
    expect(calls).toEqual(["focus", "sel 13-13"]);
    expect(box.scrollTop).toBe(300);
    expect(() => focusAtEnd(null)).not.toThrow();
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
