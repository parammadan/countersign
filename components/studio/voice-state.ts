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

/**
 * The browser's speech recognition constructor, or null where there is none (e.g. Firefox) or where it can't work: it
 * needs a secure (https) page, so an insecure context counts as unsupported. Never assumed.
 */
export function recognitionCtor(w: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | null {
  if (!w || typeof w !== "object") return null;
  const g = w as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; isSecureContext?: boolean };
  if (g.isSecureContext === false) return null;
  const c = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof c === "function" ? (c as RecognitionCtor) : null;
}

export type VoiceErrorCode = "not-allowed" | "service-not-allowed" | "language-not-supported" | "no-speech" | "audio-capture" | "network" | "aborted" | "other";
const KNOWN_ERRORS: readonly string[] = ["not-allowed", "service-not-allowed", "language-not-supported", "no-speech", "audio-capture", "network", "aborted"];
/**
 * The browser's error string as one of the cases the panel explains. `service-not-allowed` is Safari with Siri /
 * Dictation turned off (or speech blocked by policy), not the site permission.
 */
export function voiceError(code: string | undefined): VoiceErrorCode {
  return code && KNOWN_ERRORS.includes(code) ? (code as VoiceErrorCode) : "other";
}

/** The microphone permission, where the browser can say (navigator.permissions); "unknown" where it can't. */
export type MicPermission = "granted" | "prompt" | "denied" | "unknown";
export const micPermission = (state: string | undefined): MicPermission => (state === "granted" || state === "prompt" || state === "denied" ? state : "unknown");

export type VoiceStatus = "idle" | "requesting" | "listening" | "processing" | "done" | "error";
export type VoiceState = {
  status: VoiceStatus;
  /** what has been heard so far in this session (final and interim), shown live; never put into the box until the end */
  heard: string;
  error: VoiceErrorCode | null;
  truncated: boolean;
  autoStopped: boolean;
  /** the session ended on an error after earlier runs had heard something; that text was still added */
  stoppedEarly: VoiceErrorCode | null;
  /** when listening began (ms), for the elapsed time */
  startedAt: number | null;
};
export type VoiceAction =
  | { type: "request" }
  | { type: "listening"; at: number }
  | { type: "heard"; text: string }
  | { type: "processing" }
  | { type: "done"; truncated: boolean; autoStopped: boolean; stoppedEarly?: VoiceErrorCode }
  | { type: "error"; code: VoiceErrorCode }
  | { type: "reset" };

export const VOICE_IDLE: VoiceState = { status: "idle", heard: "", error: null, truncated: false, autoStopped: false, stoppedEarly: null, startedAt: null };

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
      return { ...s, status: "done", heard: "", error: null, truncated: a.truncated, autoStopped: a.autoStopped, stoppedEarly: a.stoppedEarly ?? null, startedAt: null };
    case "error":
      return { ...s, status: "error", heard: "", error: a.code, startedAt: null };
    case "reset":
      return VOICE_IDLE;
  }
}

/**
 * Final chunks as one list. Chrome on Android can report each growing phrase as its own final result ("the fee",
 * "the fee is $5,000"), so a chunk that is the one before plus more whole words replaces it ("Pay" then "Payment…"
 * are different words and both stay). Android can also repeat a final exactly; only when `dropRepeats` (Android) is
 * an exact consecutive repeat dropped, so a word said twice on purpose elsewhere stays.
 */
export function joinFinals(chunks: string[], dropRepeats = false): string[] {
  const out: string[] = [];
  for (const raw of chunks) {
    const c = raw.trim();
    if (!c) continue;
    const prev = out[out.length - 1];
    const lc = c.toLowerCase();
    const lp = prev?.toLowerCase();
    if (lp !== undefined && dropRepeats && lp === lc) continue;
    if (lp !== undefined && lc.startsWith(`${lp} `)) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/** Whether this browser is Chrome-on-Android-like, whose result lists can repeat a final exactly. */
export const repeatsFinals = (ua: string | undefined) => !!ua && /Android/i.test(ua);

/**
 * Final chunks and interim text in one recognition run's result list. The list holds the whole run (results before
 * `resultIndex` don't change), so re-reading it on every event can't lose or duplicate text.
 */
export function readResults(list: RecognitionResultList, dropRepeats = false): { finals: string[]; final: string; interim: string } {
  const fin: string[] = [];
  const mid: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const t = (r && r.length > 0 ? r[0]?.transcript ?? "" : "").trim();
    if (t) (r.isFinal ? fin : mid).push(t);
  }
  const finals = joinFinals(fin, dropRepeats);
  return { finals, final: finals.join(" "), interim: mid.join(" ") };
}

/**
 * Tidies a whole dictation once, when it ends: Chrome gives lowercase text without punctuation, split at short pauses,
 * so the chunks are joined with single spaces, the first letter is capitalised (only if the whole first word is lowercase), and one full
 * stop is added only when the text ends in a letter or digit. Nothing else changes: digits, amounts, names and the
 * rest of the casing stay exactly as heard, and no punctuation is added between chunks.
 */
export function tidyDictation(chunks: string[] | string, lang = "en-US"): string {
  const c = (Array.isArray(chunks) ? chunks.join(" ") : chunks).replace(/\s+/g, " ").trim();
  if (!c) return "";
  const first = String.fromCodePoint(c.codePointAt(0)!);
  const word = c.split(" ")[0];
  // only an all-lowercase first word is capitalised: "eBay", "iPhone" and "McDonald's" stay as they are
  const lower = word === word.toLocaleLowerCase(lang) && first !== first.toLocaleUpperCase(lang);
  let out = lower ? first.toLocaleUpperCase(lang) + c.slice(first.length) : c;
  // a full stop only after a letter of an alphabet that uses one (not Chinese / Japanese / Thai…) or a digit
  if (/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Nd}]$/u.test(out)) out += ".";
  return out;
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
/** how long to wait for the browser to end the session after Stop (some older WebKit builds never do) */
export const VOICE_STOP_GRACE_MS = 4_000;

/** Whether a session is under way (the box may still change), so the panel can hold off sending it. */
export const voiceBusy = (s: VoiceStatus) => s === "requesting" || s === "listening" || s === "processing";

export type VoiceSessionOptions = {
  lang: string;
  dispatch: (a: VoiceAction) => void;
  /** adds the final text to the box; returns whether some of it was cut to fit */
  append: (text: string) => boolean;
  maxMs?: number;
  stopGraceMs?: number;
  startGraceMs?: number;
  maxRestarts?: number;
  /** drop exact consecutive repeats of a final (Chrome on Android); see joinFinals */
  dropRepeats?: boolean;
  now?: () => number;
};
export type VoiceSession = { stop(): void; abort(): void };

/** how long a permission prompt may stay unanswered before the session quietly goes back to the start */
export const VOICE_START_GRACE_MS = 15_000;
/** how many times a session that the browser ended on its own (Safari, after each phrase) is started again */
export const VOICE_MAX_RESTARTS = 20;

/**
 * One listening session, possibly over several recognition runs: Safari ends a run on its own after a phrase, so a run
 * that ended cleanly after hearing something is started again until the person stops, 60 seconds pass, or a run hears
 * nothing (silence). A run that ends on an error (network, microphone…) is not restarted: the session ends, and text
 * heard before it is still added, with a note. At the end, the text, tidied, is added to the box through `append`, once. `abort()` (unmount, page hide) ends it silently, adding nothing. Nothing else happens: the
 * person reviews the text and submits it themselves.
 */
export function startVoiceSession(Ctor: RecognitionCtor, o: VoiceSessionOptions): VoiceSession {
  const now = o.now ?? Date.now;
  const maxRestarts = o.maxRestarts ?? VOICE_MAX_RESTARTS;
  let rec: RecognitionLike | null = null;
  /** final chunks from runs that have ended */
  const kept: string[] = [];
  let finals: string[] = [];
  let interim = "";
  let err: VoiceErrorCode | null = null;
  let stopRequested = false;
  let autoStopped = false;
  let live = false;
  let over = false;
  let restarts = 0;
  let startedAt = 0;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    for (const t of [maxTimer, stopTimer, startTimer]) if (t !== undefined) clearTimeout(t);
  };
  const detach = (r: RecognitionLike | null) => {
    if (r) r.onstart = r.onaudiostart = r.onresult = r.onspeechend = r.onerror = r.onend = null;
  };
  const kill = (r: RecognitionLike | null) => {
    detach(r);
    try {
      r?.abort();
    } catch {
      /* already ended */
    }
  };
  const chunks = (withInterim: boolean) => joinFinals([...kept, ...finals, ...(withInterim && interim ? [interim] : [])], o.dropRepeats);
  const text = (withInterim: boolean) => tidyDictation(chunks(withInterim), o.lang);

  const finish = () => {
    if (over) return;
    over = true;
    clearTimers();
    detach(rec);
    // the whole dictation is tidied once, here. A run the browser ended itself may leave unfinalised words (Safari rarely marks results final): keep them too
    const t = text(true);
    if (err && !(t.trim() && (err === "no-speech" || err === "aborted"))) {
      // an error in a restarted run: what earlier runs heard is kept (with the failed run's confirmed words), and the
      // note says the session stopped early. With nothing kept, it's just the error.
      const before = kept.length ? tidyDictation(joinFinals([...kept, ...finals], o.dropRepeats), o.lang) : "";
      if (!before) return o.dispatch({ type: "error", code: err });
      const truncated = o.append(before);
      return o.dispatch({ type: "done", truncated, autoStopped, stoppedEarly: err });
    }
    // silence or the browser aborting after something was heard: keep what was heard
    // never opened (a permission prompt dismissed, or cancelled first): back to the start, nothing to report
    if (!t.trim()) return o.dispatch(!live ? { type: "reset" } : { type: "error", code: "no-speech" });
    const truncated = o.append(t);
    o.dispatch({ type: "done", truncated, autoStopped });
  };
  const goLive = () => {
    if (live || over) return;
    live = true;
    clearTimeout(startTimer);
    startedAt = now();
    o.dispatch({ type: "listening", at: startedAt });
    maxTimer = setTimeout(() => {
      autoStopped = true;
      stop();
    }, o.maxMs ?? VOICE_MAX_MS);
  };
  const stop = () => {
    if (over || stopRequested) return;
    stopRequested = true;
    o.dispatch({ type: "processing" });
    // if the browser never ends the run, end it here and keep what was heard (as a normal stop does)
    stopTimer = setTimeout(() => {
      if (over) return;
      kill(rec);
      finish();
    }, o.stopGraceMs ?? VOICE_STOP_GRACE_MS);
    try {
      rec?.stop();
    } catch {
      finish();
    }
  };

  const run = (): boolean => {
    let r: RecognitionLike;
    try {
      r = new Ctor();
      r.lang = o.lang;
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
    } catch {
      return false;
    }
    rec = r;
    finals = [];
    interim = "";
    // a run going live is shown by whichever comes first: onaudiostart isn't reliable (Chrome on Android), onstart or a result is
    r.onstart = () => goLive();
    r.onaudiostart = () => goLive();
    r.onresult = (e) => {
      if (over || r !== rec) return;
      goLive();
      ({ finals, interim } = readResults(e.results, o.dropRepeats));
      o.dispatch({ type: "heard", text: [...chunks(false), interim].filter(Boolean).join(" ") });
    };
    r.onerror = (e) => {
      if (r === rec && !err) err = voiceError(e?.error);
    };
    r.onend = () => {
      if (over || r !== rec) return;
      const heard = finals.length > 0 || !!interim;
      const ranOut = now() - startedAt >= (o.maxMs ?? VOICE_MAX_MS);
      // the browser ended the run itself after hearing something: keep it, and listen on
      if (live && !stopRequested && !err && heard && !ranOut && restarts < maxRestarts) {
        kept.push(...joinFinals([...finals, ...(interim ? [interim] : [])], o.dropRepeats));
        // now in `kept`: cleared so a restart that fails can't add them twice
        finals = [];
        interim = "";
        restarts++;
        detach(r);
        if (run()) return;
      }
      finish();
    };
    try {
      r.start();
    } catch {
      detach(r);
      return false;
    }
    return true;
  };

  o.dispatch({ type: "request" });
  // a prompt left unanswered or dismissed without an event: quietly back to the start
  const startTimer = setTimeout(() => {
    if (over || live) return;
    kill(rec);
    finish();
  }, o.startGraceMs ?? VOICE_START_GRACE_MS);
  if (!run()) {
    err = "other";
    finish();
  }
  return {
    stop,
    abort() {
      if (over) return;
      over = true;
      clearTimers();
      kill(rec);
    },
  };
}

/** "0:07" for 7 seconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
