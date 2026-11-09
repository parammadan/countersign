// Re-runs `tick` every `ms` while the page is visible; stops while it's hidden and catches up (one tick) when it
// comes back. Returns a function that stops it. Pure, so it's tested without a browser.
type Doc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

export function startPolling(tick: () => void, ms: number, doc: Doc): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const run = () => {
    if (!timer) timer = setInterval(tick, ms);
  };
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") {
      tick();
      run();
    } else pause();
  };
  if (doc.visibilityState === "visible") run();
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    pause();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/** A client file is waiting on someone (the client, or the firm's countersignature) only in these states. */
export const LIVE_STATUSES = ["sent", "viewed", "signed"] as const;
export const isLiveStatus = (s: string) => (LIVE_STATUSES as readonly string[]).includes(s);
