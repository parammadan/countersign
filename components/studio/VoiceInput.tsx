"use client";

// "Speak instead" for the AI panel's description box. The browser's speech recognition (where it exists) turns speech
// into text, which is added after what is already in the box for the person to check. It never submits: the person
// presses "Fill details with AI" themselves. No audio is recorded, stored or uploaded by AgreementOS.
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Button, Notice, cx } from "@/components/ui";
import { VOICE_COPY } from "./ai-state";
import { VOICE_IDLE, VOICE_MAX_MS, clock, mergeTranscript, recognitionCtor, startVoiceSession, voiceBusy, voiceReducer, type VoiceSession, type VoiceState } from "./voice-state";

export type VoiceSupport = "unknown" | "supported" | "unsupported";

const noSubscribe = () => () => {};
// the server (and the first client render, during hydration) doesn't know: nothing is shown until the client checks
const clientSupport = (): VoiceSupport => (recognitionCtor() ? "supported" : "unsupported");
const serverSupport = (): VoiceSupport => "unknown";

function MicGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </svg>
  );
}

/** What the voice control shows for a given state. Pure rendering, so the server-side markup can be tested. */
export function VoicePanel({ support, state, elapsed, disabled, onStart, onStop }: { support: VoiceSupport; state: VoiceState; elapsed: number; disabled?: boolean; onStart: () => void; onStop: () => void }) {
  if (support === "unknown") return null;
  if (support === "unsupported") return <p data-testid="voice-unsupported" className="mt-2 text-xs text-muted">{VOICE_COPY.unsupported}</p>;
  const { status } = state;
  const active = status === "requesting" || status === "listening";
  const status_text =
    status === "requesting" ? VOICE_COPY.requesting
    : status === "listening" ? `${VOICE_COPY.listening} ${clock(elapsed)} of ${clock(VOICE_MAX_MS)}`
    : status === "processing" ? VOICE_COPY.processing
    : status === "done" ? [VOICE_COPY.done, state.autoStopped && VOICE_COPY.autoStopped, state.truncated && VOICE_COPY.truncated].filter(Boolean).join(" ")
    : status === "error" && state.error ? VOICE_COPY.errors[state.error]
    : "";
  return (
    <div data-testid="voice-input" className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {status !== "error" && (
          <Button
            type="button"
            variant={active ? "danger" : "secondary"}
            size="sm"
            aria-pressed={active}
            aria-controls="voice-status"
            onClick={active ? onStop : onStart}
            disabled={(disabled && !active) || status === "processing"}
            loading={status === "processing"}
          >
            {status === "listening" ? (
              <span aria-hidden className="relative inline-flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-bad opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-bad" />
              </span>
            ) : status !== "processing" && <MicGlyph size={15} />}
            {active ? VOICE_COPY.stop : VOICE_COPY.start}
          </Button>
        )}
        <span className="text-xs text-muted">{VOICE_COPY.privacy}</span>
      </div>
      {/* announced to screen readers; the live words below are not, to keep it quiet while speaking */}
      <p id="voice-status" role="status" aria-live="polite" className={cx("text-sm", status_text ? "mt-2" : "sr-only", status === "error" ? "sr-only" : "text-ink-2")}>
        {status_text}
      </p>
      {(status === "listening" || status === "processing") && state.heard && (
        <p data-testid="voice-heard" className="mt-1 rounded-lg border border-dashed border-line-strong bg-white/70 px-3 py-2 text-sm text-ink-2">
          <span className="mr-1 text-xs font-medium text-muted">{VOICE_COPY.heard}:</span>
          {state.heard}
        </p>
      )}
      {status === "error" && state.error && (
        <div className="mt-2">
          <Notice tone={state.error === "aborted" ? "info" : "warn"}>
            <span className="flex flex-wrap items-center gap-2">
              <span>{VOICE_COPY.errors[state.error]}</span>
              <Button type="button" variant="secondary" size="sm" onClick={onStart} disabled={disabled}>{VOICE_COPY.retry}</Button>
            </span>
          </Notice>
        </div>
      )}
    </div>
  );
}

/**
 * The voice control for a text box: adds what was said after its current value (cut to `maxLength`), through
 * `onChange` only. It has no other effect, so it can't submit or send anything. `onBusyChange` says when a session is
 * under way (the box may still change), so the panel can hold off sending the box until it ends.
 */
export function VoiceInput({ value, onChange, maxLength, disabled, onBusyChange }: { value: string; onChange: (next: string) => void; maxLength: number; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const support = useSyncExternalStore(noSubscribe, clientSupport, serverSupport);
  const [state, dispatch] = useReducer(voiceReducer, VOICE_IDLE);
  const [now, setNow] = useState(0);
  const session = useRef<VoiceSession | null>(null);
  // the box's latest value and setter, so text is added to what is there when speech ends (the person may have typed)
  const latest = useRef({ value, onChange, maxLength });
  useEffect(() => {
    latest.current = { value, onChange, maxLength };
  });

  // stop listening when the panel goes away or the page is left
  useEffect(() => {
    const end = () => {
      session.current?.abort();
      session.current = null;
    };
    window.addEventListener("pagehide", end);
    return () => {
      window.removeEventListener("pagehide", end);
      end();
    };
  }, []);

  const busy = voiceBusy(state.status);
  const busyCb = useRef(onBusyChange);
  useEffect(() => {
    busyCb.current = onBusyChange;
  });
  useEffect(() => {
    busyCb.current?.(busy);
  }, [busy]);
  // not busy any more once the control goes away
  useEffect(() => () => busyCb.current?.(false), []);

  const listening = state.status === "listening";
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [listening]);

  function start() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    session.current?.abort();
    setNow(Date.now());
    session.current = startVoiceSession(Ctor, {
      lang: (typeof navigator !== "undefined" && navigator.language) || "en-US",
      dispatch,
      append: (text) => {
        const { value: v, onChange: set, maxLength: max } = latest.current;
        const r = mergeTranscript(v, text, max);
        if (r.text !== v) set(r.text);
        latest.current.value = r.text;
        return r.truncated;
      },
    });
  }
  const stop = () => session.current?.stop();

  const elapsed = state.startedAt ? Math.max(0, now - state.startedAt) : 0;
  return <VoicePanel support={support} state={state} elapsed={elapsed} disabled={disabled} onStart={start} onStop={stop} />;
}
