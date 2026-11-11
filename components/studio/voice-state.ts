// Voice input for the Studio description box: the pure parts (state, transcript merge) and the small controller that
// drives the browser's speech recognition. Plain module (no "use client", no DOM access at import), so it can be
// tested without a browser. It only ever adds text to the box: it never submits, suggests, creates or sends anything.

/** The subset of the Web Speech API's SpeechRecognition this uses (browsers ship it prefixed or not, or not at all). */
export type RecognitionResultList = ArrayLike<{ isFinal: boolean; length: number; [i: number]: { transcript: string } }>;
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((e: unknown) => void) | null;
  onaudiostart: ((e: unknown) => void) | null;
  onresult: ((e: { resultIndex?: number; results: RecognitionResultList }) => void) | null;
  onspeechend: ((e: unknown) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: ((e: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => RecognitionLike;

/** The browser's speech recognition constructor, or null where there is none (e.g. Firefox). Never assumed. */
export function recognitionCtor(w: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | null {
  if (!w || typeof w !== "object") return null;
  const g = w as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const c = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof c === "function" ? (c as RecognitionCtor) : null;
}

export type VoiceErrorCode = "not-allowed" | "no-speech" | "audio-capture" | "network" | "aborted" | "other";
/** The browser's error string as one of the cases the panel explains. */
export function voiceError(code: string | undefined): VoiceErrorCode {
  if (code === "not-allowed" || code === "service-not-allowed") return "not-allowed";
  if (code === "no-speech" || code === "audio-capture" || code === "network" || code === "aborted") return code;
  return "other";
}

export type VoiceStatus = "idle" | "requesting" | "listening" | "processing" | "done" | "error";
export type VoiceState = {
  status: VoiceStatus;
  /** what has been heard so far in this session (final and interim), shown live; never put into the box until the end */
  heard: string;
  error: VoiceErrorCode | null;
  truncated: boolean;
  autoStopped: boolean;
  /** when listening began (ms), for the elapsed time */
  startedAt: number | null;
};
export type VoiceAction =
  | { type: "request" }
  | { type: "listening"; at: number }
  | { type: "heard"; text: string }
  | { type: "processing" }
  | { type: "done"; truncated: boolean; autoStopped: boolean }
  | { type: "error"; code: VoiceErrorCode }
  | { type: "reset" };

export const VOICE_IDLE: VoiceState = { status: "idle", heard: "", error: null, truncated: false, autoStopped: false, startedAt: null };

export function voiceReducer(s: VoiceState, a: VoiceAction): VoiceState {
  switch (a.type) {
    case "request":
      return { ...VOICE_IDLE, status: "requesting" };
    case "listening":
      return s.status === "requesting" ? { ...s, status: "listening", startedAt: a.at } : s;
    case "heard":
      return s.status === "listening" || s.status === "processing" ? { ...s, heard: a.text } : s;
    case "processing":
      return s.status === "listening" || s.status === "requesting" ? { ...s, status: "processing" } : s;
    case "done":
      return { ...s, status: "done", heard: "", error: null, truncated: a.truncated, autoStopped: a.autoStopped, startedAt: null };
    case "error":
      return { ...s, status: "error", heard: "", error: a.code, startedAt: null };
    case "reset":
      return VOICE_IDLE;
  }
}

/** Final and interim text in the browser's result list (the whole session's results, so it is safe to re-read). */
export function readResults(list: RecognitionResultList): { final: string; interim: string } {
  const fin: string[] = [];
  const mid: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const t = (r && r.length > 0 ? r[0]?.transcript ?? "" : "").trim();
    if (t) (r.isFinal ? fin : mid).push(t);
  }
  return { final: fin.join(" "), interim: mid.join(" ") };
}

/**
 * Adds spoken text after what is already in the box (never replacing it), separated by a space (or nothing after a
 * line break / trailing space), and cut to the box's maximum length. `truncated` says some of it didn't fit.
 */
export function mergeTranscript(existing: string, addition: string, max: number): { text: string; truncated: boolean } {
  const add = addition.replace(/\s+/g, " ").trim();
  if (!add) return { text: existing, truncated: false };
  const sep = existing === "" || /\s$/.test(existing) ? "" : " ";
  const room = max - existing.length - sep.length;
  if (room <= 0) return { text: existing, truncated: true };
  if (add.length <= room) return { text: existing + sep + add, truncated: false };
  let cut = add.slice(0, room);
  // don't leave half of a surrogate pair (an emoji or rare character) at the end
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.trimEnd();
  return { text: cut ? existing + sep + cut : existing, truncated: true };
}

export const VOICE_MAX_MS = 60_000;

export type VoiceSessionOptions = {
  lang: string;
  dispatch: (a: VoiceAction) => void;
  /** adds the final text to the box; returns whether some of it was cut to fit */
  append: (text: string) => boolean;
  maxMs?: number;
  now?: () => number;
};
export type VoiceSession = { stop(): void; abort(): void };

/**
 * One listening session. Shows what is heard as it comes, and at the end adds the final text to the box through
 * `append`, once. Stops on the browser's speech-end event, on `stop()`, or after `maxMs`. `abort()` (unmount, page
 * hide) ends it silently, adding nothing. Nothing else happens: the person reviews the text and submits it themselves.
 */
export function startVoiceSession(Ctor: RecognitionCtor, o: VoiceSessionOptions): VoiceSession {
  const now = o.now ?? Date.now;
  let rec: RecognitionLike;
  let final = "";
  let interim = "";
  let err: VoiceErrorCode | null = null;
  let stopRequested = false;
  let autoStopped = false;
  let live = false;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    if (over) return;
    over = true;
    if (timer !== undefined) clearTimeout(timer);
    if (err) return o.dispatch({ type: "error", code: err });
    // a stopped session keeps what was heard even if the browser didn't finalise it
    const text = final || (stopRequested ? interim : "");
    // cancelled before the microphone opened: back to the start, nothing to report
    if (!text.trim()) return o.dispatch(stopRequested && !live ? { type: "reset" } : { type: "error", code: "no-speech" });
    const truncated = o.append(text);
    o.dispatch({ type: "done", truncated, autoStopped });
  };
  const stop = () => {
    if (over || stopRequested) return;
    stopRequested = true;
    o.dispatch({ type: "processing" });
    try {
      rec.stop();
    } catch {
      finish();
    }
  };

  o.dispatch({ type: "request" });
  try {
    rec = new Ctor();
    rec.lang = o.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
  } catch {
    over = true;
    o.dispatch({ type: "error", code: "other" });
    return { stop() {}, abort() {} };
  }
  const listening = () => {
    if (live || over) return;
    live = true;
    o.dispatch({ type: "listening", at: now() });
    timer = setTimeout(() => {
      autoStopped = true;
      stop();
    }, o.maxMs ?? VOICE_MAX_MS);
  };
  rec.onstart = listening;
  rec.onaudiostart = listening;
  rec.onresult = (e) => {
    if (over) return;
    listening();
    ({ final, interim } = readResults(e.results));
    o.dispatch({ type: "heard", text: [final, interim].filter(Boolean).join(" ") });
  };
  rec.onspeechend = () => stop();
  rec.onerror = (e) => {
    if (!err) err = voiceError(e?.error);
  };
  rec.onend = () => finish();
  try {
    rec.start();
  } catch {
    err = "other";
    finish();
  }
  return {
    stop,
    abort() {
      if (over) return;
      over = true;
      if (timer !== undefined) clearTimeout(timer);
      rec.onstart = rec.onaudiostart = rec.onresult = rec.onspeechend = rec.onerror = rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already ended */
      }
    },
  };
}

/** "0:07" for 7 seconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
