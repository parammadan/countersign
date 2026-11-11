"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Notice, cx } from "../ui";
import { Icon } from "../icons";

// "Scan with phone", the phone page (/scan/<token>). Photos are taken through the browser's own file input with
// capture="environment" (the camera app; iOS hands back a JPEG) or chosen from the library (JPEG, PNG, or anything
// else this browser can open, such as HEIC on Safari). Each page is drawn on a canvas here, turned by the chosen
// rotation, scaled down to at most 2200 px on its long edge and saved as JPEG 0.85 (every path ends in
// toBlob("image/jpeg")); only those JPEGs are sent, and the server accepts nothing else. No edge detection, cropping or OCR: the pages go into the PDF as photographed.
// Every request carries the token in its path and nothing else: no cookies are needed or used.

export const OUT_LONG_EDGE = 2200;
export const OUT_QUALITY = 0.85;
const THUMB_EDGE = 360;
const FALLBACK_MAX_PAGES = 30;

type Shot = { key: string; file: File; thumb: string; rot: 0 | 1 | 2 | 3 };
type Phase =
  | { kind: "ready" }
  | { kind: "sending"; page: number; of: number; pct: number }
  | { kind: "finishing"; of: number }
  | { kind: "sent" }
  | { kind: "gone"; reason: "expired" | "ended" | "invalid" };

let seq = 0;
const isHeic = (f: File) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type);

async function loadImage(file: File): Promise<{ img: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { img, release: () => URL.revokeObjectURL(url) };
}

/** Draw `img` turned by `rot` quarter turns, scaled to fit `edge` px on its long side, as a JPEG. */
function render(img: HTMLImageElement, rot: number, edge: number, quality: number): Promise<Blob> {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const c = document.createElement("canvas");
  const turned = rot % 2 === 1;
  c.width = turned ? dh : dw;
  c.height = turned ? dw : dh;
  const g = c.getContext("2d");
  if (!g) return Promise.reject(new Error("no canvas"));
  g.fillStyle = "#fff"; // transparent PNG areas become white paper, not black
  g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rot * Math.PI) / 2);
  g.imageSmoothingQuality = "high";
  g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", quality));
}

async function pageJpeg(s: Shot): Promise<Blob> {
  const { img, release } = await loadImage(s.file);
  try {
    return await render(img, s.rot, OUT_LONG_EDGE, OUT_QUALITY);
  } finally {
    release();
  }
}

type Reply = { status: number; body: { error?: string; [k: string]: unknown } };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retry while the server says it's busy (503): 1, 2, 4, 8 s, then give up with its answer. */
async function withRetry(send: () => Promise<Reply>): Promise<Reply> {
  let r = await send();
  for (let i = 0; r.status === 503 && i < 4; i++) {
    await wait(1000 * 2 ** i);
    r = await send();
  }
  return r;
}

function put(url: string, blob: Blob, onProgress: (f: number) => void): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Type", "image/jpeg");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let body = {};
      try {
        body = JSON.parse(x.responseText);
      } catch {}
      resolve({ status: x.status, body });
    };
    x.onerror = () => reject(new Error("network"));
    x.send(blob);
  });
}

async function post(url: string, body?: unknown, method = "POST"): Promise<Reply> {
  const r = await fetch(url, { method, cache: "no-store", credentials: "omit", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function left(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function GoneMessage({ reason }: { reason: "expired" | "ended" | "invalid" | "busy" }) {
  const t =
    reason === "busy"
      ? { title: "Too many requests", body: "Wait a minute, then reload this page." }
      : reason === "expired"
      ? { title: "This scan link has expired", body: "Links work for 10 minutes. On your computer, choose Start again for a new code." }
      : reason === "ended"
        ? { title: "This scan has ended", body: "It was sent, cancelled or replaced. On your computer, choose Scan with phone again if you need to." }
        : { title: "This scan link isn't valid", body: "Scan the code on your computer again." };
  return (
    <div className="rounded-2xl border border-line bg-white p-6 text-center shadow-sm" data-testid="scan-gone">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm text-muted">{t.body}</p>
    </div>
  );
}

export function PhoneScan({ token, expiresAt: initialExpiry }: { token: string; expiresAt: string }) {
  const base = `/api/scan/phone/${encodeURIComponent(token)}`;
  const [shots, setShots] = useState<Shot[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyAdding, setBusyAdding] = useState(false);
  const [expiresAt, setExpiresAt] = useState(initialExpiry);
  const [maxPages, setMaxPages] = useState(FALLBACK_MAX_PAGES);
  const [noCamera, setNoCamera] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const camera = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const retake = useRef<HTMLInputElement>(null);
  const retakeAt = useRef<number | null>(null);
  // what each page index on the server already holds (shot key + rotation), so a retry only resends what changed
  const sent = useRef<Map<number, string>>(new Map());
  const thumbs = useRef<string[]>([]);

  // tell the desktop the phone is here (and learn the limits); a closed scan shows its message at once
  useEffect(() => {
    let off = false;
    post(base)
      .then((r) => {
        if (off) return;
        if (r.status === 410) setPhase({ kind: "gone", reason: /expired/i.test(r.body.error ?? "") ? "expired" : "ended" });
        else if (r.status === 404) setPhase({ kind: "gone", reason: "invalid" });
        else if (r.status === 200) {
          if (typeof r.body.expiresAt === "string") setExpiresAt(r.body.expiresAt);
          if (typeof r.body.maxPages === "number") setMaxPages(r.body.maxPages);
        }
      })
      .catch(() => {}); // offline for now: sending will try again and say so
    return () => {
      off = true;
    };
  }, [base]);

  // a device with no camera at all (most desktops) can still choose photos
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((d) => setNoCamera(d.length > 0 && !d.some((x) => x.kind === "videoinput")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = new Date(expiresAt).getTime() - clock;

  useEffect(() => {
    const list = thumbs.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  async function toShot(file: File): Promise<Shot | string> {
    try {
      const { img, release } = await loadImage(file);
      try {
        const t = await render(img, 0, THUMB_EDGE, 0.7);
        const thumb = URL.createObjectURL(t);
        thumbs.current.push(thumb);
        return { key: `s${++seq}`, file, thumb, rot: 0 };
      } finally {
        release();
      }
    } catch {
      return isHeic(file)
        ? "This photo is in HEIC format, which this browser can't open. Use Take photo, or choose a JPEG or PNG."
        : `“${file.name || "That photo"}” couldn't be opened. Choose a JPEG or PNG photo.`;
    }
  }

  async function add(files: FileList | null, at?: number) {
    if (!files?.length) return;
    setErr(null);
    setNote(null);
    setBusyAdding(true);
    try {
      const list = Array.from(files);
      if (at !== undefined) {
        const s = await toShot(list[0]);
        if (typeof s === "string") return setErr(s);
        setShots((cur) => cur.map((x, i) => (i === at ? s : x)));
        return;
      }
      const room = maxPages - shots.length;
      if (room <= 0) return setErr(`That's the most a scan can have (${maxPages} pages).`);
      const fresh: Shot[] = [];
      const problems: string[] = [];
      for (const f of list.slice(0, room)) {
        const s = await toShot(f);
        if (typeof s === "string") problems.push(s);
        else fresh.push(s);
      }
      setShots((cur) => [...cur, ...fresh].slice(0, maxPages));
      if (problems.length) setErr(problems[0]);
      if (list.length > room) setNote(`Only the first ${room} were added: a scan can have up to ${maxPages} pages.`);
    } finally {
      setBusyAdding(false);
    }
  }

  const edit = (fn: (cur: Shot[]) => Shot[]) => {
    setErr(null);
    setShots(fn);
  };
  const rotate = (i: number) => edit((cur) => cur.map((s, j) => (j === i ? { ...s, rot: (((s.rot + 1) % 4) as Shot["rot"]) } : s)));
  const move = (i: number, d: -1 | 1) =>
    edit((cur) => {
      const n = [...cur];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const remove = (i: number) => edit((cur) => cur.filter((_, j) => j !== i));

  async function send() {
    if (!shots.length) return;
    setErr(null);
    setNote(null);
    setSendFailed(false);
    const list = shots;
    const of = list.length;
    try {
      for (let i = 0; i < of; i++) {
        const sig = `${list[i].key}:${list[i].rot}`;
        setPhase({ kind: "sending", page: i + 1, of, pct: Math.round((i / of) * 100) });
        if (sent.current.get(i) === sig) continue;
        const jpeg = await pageJpeg(list[i]).catch(() => {
          throw new Error(`Page ${i + 1} couldn't be prepared. Retake it and try again.`);
        });
        const r = await withRetry(() => put(`${base}/pages/${i}`, jpeg, (f) => setPhase({ kind: "sending", page: i + 1, of, pct: Math.round(((i + f) / of) * 100) }))).catch(() => {
          throw new Error("The page didn't reach your computer. Check your connection and try again.");
        });
        if (r.status === 410) return setPhase({ kind: "gone", reason: /expired/i.test(r.body.error ?? "") ? "expired" : "ended" });
        if (r.status === 404) return setPhase({ kind: "gone", reason: "invalid" });
        if (r.status !== 200) throw new Error(`Page ${i + 1}: ${r.body.error || `upload failed (${r.status})`}`);
        sent.current.set(i, sig);
      }
      setPhase({ kind: "finishing", of });
      const r = await withRetry(() => post(`${base}/finish`, { count: of })).catch(() => {
        throw new Error("Couldn't reach your computer to finish. Check your connection and try again.");
      });
      if (r.status === 200) return setPhase({ kind: "sent" });
      if (r.status === 410) return setPhase({ kind: "gone", reason: /expired/i.test(r.body.error ?? "") ? "expired" : "ended" });
      if (r.status === 404) return setPhase({ kind: "gone", reason: "invalid" });
      if (r.status === 409) sent.current.clear(); // a page is missing on the server: send them all again
      throw new Error(r.body.error || `Sending failed (${r.status}). Try again.`);
    } catch (e) {
      setPhase({ kind: "ready" });
      setSendFailed(true);
      setErr((e as Error).message || "Sending failed. Try again.");
    }
  }

  if (phase.kind === "gone") return <GoneMessage reason={phase.reason} />;
  // past its time on this phone's clock (the server decides for real: a send after this answers 410)
  if (remaining <= 0 && phase.kind === "ready") return <GoneMessage reason="expired" />;
  if (phase.kind === "sent")
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-center shadow-sm" data-testid="scan-sent">
        <div aria-hidden className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Icon name="checkCircle" size={26} />
        </div>
        <h1 className="mt-4 text-xl font-semibold">Sent</h1>
        <p role="status" className="mt-2 text-sm text-muted">Sent. You can close this page.</p>
        <p className="mt-1 text-xs text-muted">Your computer opens the draft so you can check the fields. Nothing goes to a client from here.</p>
      </div>
    );

  const busy = phase.kind === "sending" || phase.kind === "finishing";
  const full = shots.length >= maxPages;

  return (
    <div>
      <h1 className="text-xl font-semibold">Photograph the agreement</h1>
      <p className="mt-1 text-sm text-muted">One photo per page, in order, flat and well lit. You can turn, reorder or retake pages before you send.</p>
      <p className="mt-1 text-xs text-muted tabular" data-testid="scan-expiry" suppressHydrationWarning>
        This link works for another {left(remaining)}.
      </p>

      {/* the inputs: the camera (capture), the photo library, and a retake for one page */}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden data-testid="scan-camera-input" onChange={(e) => { const f = e.target.files; void add(f).finally(() => (e.target.value = "")); }} />
      <input ref={chooser} type="file" accept="image/*" multiple hidden data-testid="scan-choose-input" onChange={(e) => { const f = e.target.files; void add(f).finally(() => (e.target.value = "")); }} />
      <input
        ref={retake}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="scan-retake-input"
        onChange={(e) => {
          const at = retakeAt.current;
          retakeAt.current = null;
          void add(e.target.files, at ?? undefined).finally(() => (e.target.value = ""));
        }}
      />

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button size="lg" icon="phone" disabled={busy || full || busyAdding} onClick={() => camera.current?.click()}>
          Take photo
        </Button>
        <Button size="lg" variant="secondary" icon="upload" disabled={busy || full || busyAdding} onClick={() => chooser.current?.click()}>
          Choose photos
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {noCamera ? "No camera was found on this device, so choose photos instead. " : "If the camera doesn't open, or you said no to camera access, use Choose photos. "}
        Pages are sent as JPEG. HEIC photos from the library open only in browsers that support them (such as Safari).
      </p>

      <div className="mt-3 space-y-2" aria-live="polite">
        {err && <Notice tone="error">{err}</Notice>}
        {note && <Notice tone="warn">{note}</Notice>}
        {busyAdding && <p className="text-sm text-muted">Adding…</p>}
      </div>

      <div className="mt-5 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Pages</h2>
        <span className="text-sm text-muted tabular" data-testid="scan-count">
          {shots.length} page{shots.length === 1 ? "" : "s"}
          {full ? ` (the most is ${maxPages})` : ""}
        </span>
      </div>
      {shots.length === 0 ? (
        <p className="mt-2 rounded-xl border border-dashed border-line-strong bg-white px-4 py-8 text-center text-sm text-muted">No pages yet. Take a photo of the first page.</p>
      ) : (
        <ol className="mt-2 space-y-2" aria-label="Pages">
          {shots.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3 rounded-xl border border-line bg-white p-2 shadow-sm" data-testid="scan-page">
              <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100">
                {/* a local preview of this page (a blob: URL made on this phone) */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.thumb} alt={`Page ${i + 1}`} className="max-h-full max-w-full object-contain transition-transform" style={{ transform: `rotate(${s.rot * 90}deg)` }} data-rot={s.rot} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Page {i + 1}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Tool label={`Rotate page ${i + 1}`} disabled={busy} onClick={() => rotate(i)}>⟳</Tool>
                  <Tool label={`Move page ${i + 1} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</Tool>
                  <Tool label={`Move page ${i + 1} down`} disabled={busy || i === shots.length - 1} onClick={() => move(i, 1)}>↓</Tool>
                  <Tool
                    label={`Retake page ${i + 1}`}
                    disabled={busy || busyAdding}
                    onClick={() => {
                      retakeAt.current = i;
                      retake.current?.click();
                    }}
                  >
                    Retake
                  </Tool>
                  <Tool label={`Delete page ${i + 1}`} disabled={busy} onClick={() => remove(i)} danger>
                    Delete
                  </Tool>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto max-w-xl">
          {busy ? (
            <div role="status" aria-live="polite" data-testid="scan-progress">
              <p className="text-sm font-medium">{phase.kind === "sending" ? `Sending page ${phase.page} of ${phase.of}…` : "Making the PDF on your computer…"}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-label="Sending" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase.kind === "sending" ? phase.pct : 100}>
                <div className={cx("h-full rounded-full bg-brand transition-[width]", phase.kind === "finishing" && "animate-pulse")} style={{ width: `${phase.kind === "sending" ? phase.pct : 100}%` }} />
              </div>
            </div>
          ) : (
            <Button size="lg" className="w-full" icon="send" disabled={!shots.length || busyAdding} onClick={send}>
              {sendFailed && err ? "Try again" : `Send to computer${shots.length ? ` (${shots.length} page${shots.length === 1 ? "" : "s"})` : ""}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Tool({ label, children, onClick, disabled, danger }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-2.5 text-sm font-medium disabled:opacity-40",
        danger ? "border-[#f3c3be] text-bad" : "border-line-strong text-ink",
      )}
    >
      {children}
    </button>
  );
}
