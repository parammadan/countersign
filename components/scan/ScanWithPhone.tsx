"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Modal } from "../SignaturePad";
import { Button, cx, inputCls } from "../ui";
import { Icon } from "../icons";

// "Scan with phone" next to the agreement upload (admins only, like the upload itself; desktop widths only). The
// dialog shows a QR code for a 10-minute phone link (made on the server, lib/qr.ts), then follows the scan by asking
// /api/scan/session/<id> every 2 s: waiting for the phone, phone connected, N pages received, building the PDF, and
// once the draft exists it opens its field editor. Closing the dialog cancels a scan that hasn't been sent yet.

export const POLL_MS = 2_000;
export const MAX_BACKOFF_MS = 30_000;
/** after the link's own expiry, keep asking this long (a PDF being built when the link expired still finishes) */
const GRACE_MS = 6 * 60_000;

type Status = "waiting" | "connected" | "building" | "done" | "failed" | "cancelled" | "expired";
type Scan = { id: string; url: string; qr: string; expiresAt: string };
type St = { status: Status; pages: number; expiresAt: string; versionId?: string; error?: string };
const STATUSES: readonly string[] = ["waiting", "connected", "building", "done", "failed", "cancelled", "expired"];
const live = (s: Status) => s === "waiting" || s === "connected" || s === "building";

const layer = (n: React.ReactNode) => (typeof document === "undefined" ? n : createPortal(n, document.body));

function left(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function statusLine(st: St): string {
  switch (st.status) {
    case "waiting":
      return "Waiting for your phone…";
    case "connected":
      return st.pages > 0 ? `${st.pages} page${st.pages === 1 ? "" : "s"} received…` : "Phone connected. Take a photo of each page, then tap Send to computer.";
    case "building":
      return `Building the PDF from ${st.pages} page${st.pages === 1 ? "" : "s"}…`;
    case "done":
      return "Done. Opening the draft…";
    case "failed":
      return st.error || "Making the PDF failed.";
    case "cancelled":
      return "This scan was cancelled.";
    case "expired":
      return "The code expired before the pages arrived.";
  }
}

export function ScanWithPhone({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [st, setSt] = useState<St | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const [clock, setClock] = useState(0);
  const fails = useRef(0);

  const start = useCallback(async () => {
    setStarting(true);
    setStartErr(null);
    setScan(null);
    setSt(null);
    setStopped(false);
    setReconnecting(false);
    setCopied(null);
    fails.current = 0;
    try {
      const r = await fetch("/api/scan", { method: "POST", cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as Partial<Scan> & { error?: string };
      if (!r.ok || !j.id || !j.url || !j.qr || !j.expiresAt) throw new Error(j.error || `Couldn't start a scan (${r.status}). Try again.`);
      setScan(j as Scan);
      setSt({ status: "waiting", pages: 0, expiresAt: j.expiresAt });
      setClock(Date.now());
    } catch (e) {
      setStartErr(e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : (e as Error).message);
    } finally {
      setStarting(false);
    }
  }, []);

  const openDialog = () => {
    setOpen(true);
    void start();
  };

  const close = () => {
    // a scan that hasn't been sent stops here, so its link can't be used afterwards
    if (scan && st && (st.status === "waiting" || st.status === "connected"))
      void fetch(`/api/scan/session/${encodeURIComponent(scan.id)}/cancel`, { method: "POST", cache: "no-store" }).catch(() => {});
    setOpen(false);
    setScan(null);
    setSt(null);
  };

  // the countdown
  const ticking = open && !!st && (st.status === "waiting" || st.status === "connected");
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // follow the scan: every 2 s, backing off (up to 30 s) while the network fails
  const id = scan?.id;
  const expiresAt = scan?.expiresAt;
  const watching = open && !!id && !!st && live(st.status) && !stopped;
  useEffect(() => {
    if (!watching || !id || !expiresAt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const tick = async () => {
      if (Date.now() > new Date(expiresAt).getTime() + GRACE_MS) {
        setStopped(true);
        return;
      }
      let wait = POLL_MS;
      try {
        const r = await fetch(`/api/scan/session/${encodeURIComponent(id)}`, { cache: "no-store", signal: ctrl.signal });
        if (cancelled) return;
        if (r.status === 404) {
          setSt((cur) => (cur ? { ...cur, status: "cancelled" } : cur));
          return;
        }
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as St;
        if (cancelled) return;
        if (!STATUSES.includes(j.status)) throw new Error("bad status");
        fails.current = 0;
        setReconnecting(false);
        setSt(j);
        if (!live(j.status)) return;
      } catch {
        if (cancelled) return;
        fails.current++;
        setReconnecting(true);
        wait = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** fails.current);
      }
      if (!cancelled) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [watching, id, expiresAt]);

  // done: open the new draft's field editor
  const versionId = st?.status === "done" ? st.versionId : undefined;
  useEffect(() => {
    if (versionId) router.push(`/app/agreements/${encodeURIComponent(versionId)}`);
  }, [versionId, router]);

  async function copy() {
    if (!scan) return;
    try {
      await navigator.clipboard.writeText(scan.url);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  const remaining = st && clock ? new Date(st.expiresAt).getTime() - clock : null;
  const ended = st && (st.status === "failed" || st.status === "cancelled" || st.status === "expired");
  const showQr = scan && st && (st.status === "waiting" || st.status === "connected");

  return (
    <>
      <Button variant="secondary" icon="phone" className={cx("max-lg:hidden", className)} onClick={openDialog} aria-haspopup="dialog">
        Scan with phone
      </Button>
      {open &&
        layer(
          <Modal title="Scan with your phone" onClose={close}>
            <div className="flex flex-col items-center text-center" data-testid="scan-dialog">
              {!st ? (
                startErr ? (
                  <>
                    <p role="alert" className="text-sm text-bad">{startErr}</p>
                    <Button className="mt-4" onClick={start} loading={starting}>Try again</Button>
                  </>
                ) : (
                  <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
                    <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                    Making a code…
                  </p>
                )
              ) : showQr ? (
                <>
                  <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
                    {/* the SVG comes only from the qrcode library on the server, shown as an image (nothing in it can run) */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={scan.qr} alt="QR code to scan pages with your phone" width={232} height={232} className="block h-[232px] w-[232px] [image-rendering:pixelated]" data-testid="scan-qr" />
                  </div>
                  <ol className="mt-4 max-w-sm list-decimal space-y-1 pl-5 text-left text-sm text-ink">
                    <li>Scan this code with your phone&apos;s camera.</li>
                    <li>Photograph each page of the agreement, in order.</li>
                    <li>Tap <b>Send to computer</b>. The draft opens here for you to check the fields; nothing is sent to anyone.</li>
                  </ol>
                  <p className="mt-2 text-xs text-muted tabular" data-testid="scan-countdown">
                    {remaining !== null && remaining > 0 ? `The code works for ${left(remaining)}.` : "The code has expired."}
                  </p>
                  <div className="mt-3 flex w-full max-w-sm flex-col items-center gap-2">
                    <Button variant="secondary" size="sm" icon={copied === "yes" ? "check" : "copy"} onClick={copy}>
                      {copied === "yes" ? "Link copied ✓" : "Copy link"}
                    </Button>
                    {copied === "failed" && (
                      <>
                        <label htmlFor="scan-link" className="text-xs text-muted">Couldn&apos;t copy automatically. Select the link and copy it:</label>
                        <input id="scan-link" readOnly value={scan.url} className={cx(inputCls, "text-xs")} onFocus={(e) => e.currentTarget.select()} />
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div aria-hidden className={cx("mx-auto flex h-12 w-12 items-center justify-center rounded-full", st.status === "done" ? "bg-emerald-100 text-emerald-700" : ended ? "bg-gray-100 text-muted" : "bg-brand/10 text-brand")}>
                  <Icon name={st.status === "done" ? "checkCircle" : ended ? "info" : "clock"} size={26} />
                </div>
              )}

              {st && (
                <div className={cx("w-full", showQr && "mt-5 border-t border-line pt-4")}>
                  <p role="status" aria-live="polite" className={cx("flex items-center justify-center gap-2 text-sm", ended ? "mt-4 text-ink" : "text-muted")} data-testid="scan-status">
                    {stopped ? (
                      <span>Still waiting? Start again.</span>
                    ) : reconnecting && live(st.status) ? (
                      <>
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" />
                        Reconnecting…
                      </>
                    ) : (
                      <>
                        {live(st.status) && <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-brand" />}
                        {statusLine(st)}
                      </>
                    )}
                  </p>
                  {st.status === "building" && <p className="mt-1 text-xs text-muted">The draft will also appear under Agreements if you close this.</p>}
                  {(ended || stopped) && (
                    <Button className="mt-4" icon="phone" onClick={start} loading={starting}>
                      Start again
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Modal>,
        )}
    </>
  );
}
