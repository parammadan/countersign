"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Modal } from "./SignaturePad";
import { Button, cx, inputCls } from "./ui";
import { Icon } from "./icons";
import type { SignStatus } from "@/lib/sign-status";

// "Sign on your phone": on a desktop-sized screen the signing room offers a QR code of this same signing link (made
// on the server, app/s/[token]/page.tsx). The client scans it and signs on the phone through the normal flow
// (emailed code, consent, fields). Meanwhile this page asks /api/sign/[token]/status, which answers only where the
// agreement is, and once it isn't waiting any more says so here and refreshes into the page's own state.

export const POLL_OPEN_MS = 3_000; // while the dialog is open
export const POLL_IDLE_MS = 10_000; // otherwise, while the page is visible
export const MAX_BACKOFF_MS = 30_000;
export const GIVE_UP_MS = 20 * 60_000;
export const REFRESH_AFTER_MS = 8_000;

const DESKTOP = "(min-width: 1024px)"; // Tailwind's lg: the same width the button shows at

// The dialogs go to <body>: the button can sit in the signing room's sticky header, whose backdrop blur would
// otherwise trap a fixed overlay inside it. (Server-rendered markup, only ever closed outside tests, stays inline.)
const layer = (n: React.ReactNode) => (typeof document === "undefined" ? n : createPortal(n, document.body));

type Outcome = Exclude<SignStatus, "pending"> | "invalid";
const OUTCOMES: readonly string[] = ["signed", "completed", "declined", "voided", "expired"];

function useMedia(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

function useVisible() {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.visibilityState === "visible",
    () => true,
  );
}

export function outcomeText(o: Outcome, firm: string): { title: string; body: string; good: boolean } {
  switch (o) {
    case "signed":
      return { title: "Signed on your phone", body: `Thanks — ${firm} is countersigning now; you'll get the completed copy by email.`, good: true };
    case "completed":
      return { title: "Signed on your phone", body: `Thanks — ${firm} has countersigned too, so the agreement is complete. You'll get the completed copy by email.`, good: true };
    case "declined":
      return { title: "You declined this agreement", body: `We let ${firm} know. They'll be in touch.`, good: false };
    case "voided":
      return { title: "This agreement was withdrawn", body: `${firm} cancelled this signing request. Contact them if you think this is a mistake.`, good: false };
    case "expired":
      return { title: "This link has expired", body: `Ask ${firm} to send it again.`, good: false };
    case "invalid":
      return { title: "This link isn't valid any more", body: "Reload the page. If it still doesn't open, ask the sender to resend it.", good: false };
  }
}

type Props = {
  token: string;
  firm: string;
  /** the signing link itself, exactly as emailed (the QR code encodes this) */
  signUrl: string;
  /** the QR code as an image data URL (lib/qr.ts) */
  qr: string;
  requireOtp: boolean;
  /** stop checking while this device is itself signing or declining, so the two don't race */
  paused?: boolean;
  className?: string;
  /** server-rendered tests only */
  defaultOpen?: boolean;
};

export function SignOnPhone({ token, firm, signUrl, qr, requireOtp, paused, className, defaultOpen = false }: Props) {
  const router = useRouter();
  const desktop = useMedia(DESKTOP);
  const visible = useVisible();
  const [open, setOpen] = useState(defaultOpen);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const deadline = useRef(0);
  const fails = useRef(0);

  useEffect(() => {
    deadline.current = Date.now() + GIVE_UP_MS;
  }, []);

  const openDialog = () => {
    // opening it again is someone actively waiting: start a fresh 20 minutes
    deadline.current = Date.now() + GIVE_UP_MS;
    fails.current = 0;
    setStopped(false);
    setReconnecting(false);
    setCopied(null);
    setOpen(true);
  };

  // Ask where the agreement is: every 3 s with the dialog open, every 10 s otherwise while the page is visible (only
  // on a desktop-sized screen: on a phone this page is the one signing). Network errors back off (up to 30 s); after
  // 20 minutes it stops and says so.
  const watching = desktop && !paused && !outcome && !stopped && (open || visible);
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const tick = async () => {
      if (Date.now() > deadline.current) {
        setStopped(true);
        return;
      }
      const every = open ? POLL_OPEN_MS : POLL_IDLE_MS;
      let wait = every;
      try {
        const r = await fetch(`/api/sign/${encodeURIComponent(token)}/status`, { cache: "no-store", signal: ctrl.signal });
        if (r.status === 404) {
          setOutcome("invalid");
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        const { status } = (await r.json()) as { status?: string };
        if (status !== "pending" && !OUTCOMES.includes(status ?? "")) throw new Error("bad status");
        fails.current = 0;
        setReconnecting(false);
        if (status !== "pending") {
          setOutcome(status as Outcome);
          return;
        }
      } catch {
        if (cancelled) return;
        fails.current++;
        setReconnecting(true);
        wait = Math.min(MAX_BACKOFF_MS, every * 2 ** fails.current);
      }
      if (!cancelled) timer = setTimeout(tick, wait);
    };
    // check at once when the dialog opens (or the page comes back into view), then on the interval
    timer = setTimeout(tick, open ? 0 : POLL_IDLE_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [watching, open, token]);

  const refresh = useCallback(() => router.refresh(), [router]);
  // say what happened here first, then let the page show its own state for it (signed, complete, declined...)
  useEffect(() => {
    if (!outcome) return;
    const t = setTimeout(refresh, REFRESH_AFTER_MS);
    return () => clearTimeout(t);
  }, [outcome, refresh]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(signUrl);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  if (outcome) {
    const t = outcomeText(outcome, firm);
    return layer(
      <Modal title={t.title} onClose={refresh}>
        <div className="text-center" data-testid="phone-outcome">
          <div
            aria-hidden="true"
            className={cx("mx-auto flex h-12 w-12 items-center justify-center rounded-full", t.good ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-muted")}
          >
            <Icon name={t.good ? "checkCircle" : "info"} size={26} />
          </div>
          <p role="status" className="mx-auto mt-4 max-w-sm text-sm text-ink">{t.body}</p>
          <Button className="mt-6" onClick={refresh}>Continue</Button>
        </div>
      </Modal>,
    );
  }

  return (
    <>
      <Button variant="secondary" icon="phone" className={cx("max-lg:hidden", className)} onClick={openDialog} aria-haspopup="dialog">
        Sign on your phone
      </Button>
      {open &&
        layer(
          <Modal title="Sign on your phone" onClose={() => setOpen(false)}>
            <div className="flex flex-col items-center text-center">
              <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
                {/* the SVG comes only from the qrcode library on the server, shown as an image (nothing in it can run) */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="QR code of this signing link" width={232} height={232} className="block h-[232px] w-[232px] [image-rendering:pixelated]" data-testid="sign-qr" />
              </div>
              <p className="mt-4 max-w-sm text-sm text-ink">Scan with your phone&apos;s camera. You&apos;ll sign there; this page updates when you&apos;re done.</p>
              {requireOtp && <p className="mt-1.5 max-w-sm text-xs text-muted">Your phone will ask for a code we email you, the same as here.</p>}
              <div className="mt-4 flex w-full max-w-sm flex-col items-center gap-2">
                <Button variant="secondary" icon={copied === "yes" ? "check" : "copy"} onClick={copy}>
                  {copied === "yes" ? "Link copied ✓" : "Copy link"}
                </Button>
                {copied === "failed" && (
                  <>
                    <label htmlFor="sign-link" className="text-xs text-muted">Couldn&apos;t copy automatically. Select the link and copy it:</label>
                    <input id="sign-link" readOnly value={signUrl} className={cx(inputCls, "text-xs")} onFocus={(e) => e.currentTarget.select()} />
                  </>
                )}
              </div>
              <div className="mt-5 w-full border-t border-line pt-4">
                <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm text-muted" data-testid="phone-status">
                  {stopped ? (
                    <>
                      <span>Still waiting? Reload this page.</span>
                      <button type="button" className="font-medium text-brand underline" onClick={() => location.reload()}>Reload</button>
                    </>
                  ) : reconnecting ? (
                    <>
                      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" />
                      Reconnecting…
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-brand" />
                      Waiting for you to sign on your phone…
                    </>
                  )}
                </p>
              </div>
            </div>
          </Modal>,
        )}
    </>
  );
}
