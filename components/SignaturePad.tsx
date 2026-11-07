"use client";

import { useEffect, useRef, useState } from "react";
import { Dancing_Script, Caveat } from "next/font/google";
import { Button, cx, inputCls } from "./ui";
import { inkTooSmall } from "@/lib/sign-fields";

const f1 = Dancing_Script({ subsets: ["latin"], weight: ["600"] });
const f2 = Caveat({ subsets: ["latin"], weight: ["600"] });
const FONTS = [f1.style.fontFamily, f2.style.fontFamily];

export type Adopted = { png: string; method: "drawn" | "typed" };

function trim(c: HTMLCanvasElement): { png: string; w: number; h: number } | null {
  const ctx = c.getContext("2d")!;
  const { width, height } = c;
  const d = ctx.getImageData(0, 0, width, height).data;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (d[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const ink = { w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const pad = 8;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { png: out.toDataURL("image/png"), ...ink };
}

export function SignaturePad({
  mode,
  defaultName,
  onAdopt,
  onCancel,
  color = "#0d1f59",
}: {
  mode: "signature" | "initials";
  defaultName: string;
  onAdopt: (a: Adopted) => void;
  onCancel: () => void;
  color?: string;
}) {
  const initials = defaultName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 4);
  const [tab, setTab] = useState<"type" | "draw">("type");
  const [text, setText] = useState(mode === "initials" ? initials : defaultName);
  const [font, setFont] = useState(0);
  const [hasInk, setHasInk] = useState(false);
  const [drawErr, setDrawErr] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  const inked = useRef(false);
  useEffect(() => {
    const c = canvas.current;
    if (!c || tab !== "draw") return;
    let size = "";
    // size the drawing surface to the box; when the box changes size (a phone turned sideways) the old
    // strokes would no longer line up with the finger, so start over and say why
    const setup = () => {
      const r = c.getBoundingClientRect();
      const next = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (next === size) return;
      const resized = size !== "";
      size = next;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.floor(r.width * dpr);
      c.height = Math.floor(r.height * dpr);
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      if (resized && inked.current) setDrawErr("The drawing box changed size, so it was cleared. Please draw again.");
      inked.current = false;
      setHasInk(false);
    };
    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [tab, color]);

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  async function adoptTyped() {
    const t = text.trim();
    if (!t) return;
    const fam = FONTS[font];
    try {
      await document.fonts.load(`96px ${fam}`);
    } catch {}
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = `96px ${fam}`;
    const w = Math.ceil(ctx.measureText(t).width) + 40;
    c.width = Math.min(2000, w);
    c.height = 160;
    const g = c.getContext("2d")!;
    g.font = `96px ${fam}`;
    g.fillStyle = color;
    g.textBaseline = "middle";
    g.fillText(t, 20, 84, c.width - 40);
    const t2 = trim(c);
    if (t2) onAdopt({ png: t2.png, method: "typed" });
  }

  function adoptDrawn() {
    if (!canvas.current || !hasInk) return;
    const t = trim(canvas.current);
    const dpr = window.devicePixelRatio || 1;
    if (!t || inkTooSmall(mode, t.w / dpr, t.h / dpr)) {
      setDrawErr(`That's too small to read as ${mode === "initials" ? "initials" : "a signature"}. Draw ${mode === "initials" ? "them" : "it"} larger, using more of the box.`);
      return;
    }
    onAdopt({ png: t.png, method: "drawn" });
  }

  return (
    <div>
      <div className="mb-4 inline-flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label={`How to make your ${mode === "initials" ? "initials" : "signature"}`}>
        {(["type", "draw"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => { setTab(t); setDrawErr(null); }} className={cx("min-h-9 rounded-md px-4 py-1.5", tab === t ? "bg-brand text-white" : "text-muted")}>
            {t === "type" ? "Type" : "Draw"}
          </button>
        ))}
      </div>
      {tab === "type" ? (
        <div className="space-y-3">
          <input
            className={inputCls}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                adoptTyped();
              }
            }}
            maxLength={mode === "initials" ? 6 : 80}
            autoComplete={mode === "initials" ? "off" : "name"}
            aria-label={mode === "initials" ? "Your initials" : "Your full name"}
          />
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Style">
            {FONTS.map((fam, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setFont(i)}
                aria-pressed={font === i}
                aria-label={`${text || (mode === "initials" ? "AB" : "Your name")}, style ${i + 1}`}
                className={cx("h-20 truncate rounded-lg border bg-white px-3 text-3xl", font === i ? "border-brand ring-2 ring-brand/20" : "border-line")}
                style={{ fontFamily: fam, color }}
              >
                {text || (mode === "initials" ? "AB" : "Your name")}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <canvas
            ref={canvas}
            className="h-44 w-full touch-none rounded-lg border border-dashed border-gray-300 bg-white"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              drawing.current = pos(e);
              inked.current = true;
              setDrawErr(null);
              const ctx = canvas.current!.getContext("2d")!;
              ctx.beginPath();
              ctx.arc(drawing.current.x, drawing.current.y, 1, 0, Math.PI * 2);
              ctx.fillStyle = color;
              ctx.fill();
              setHasInk(true);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = pos(e);
              const ctx = canvas.current!.getContext("2d")!;
              const mid = { x: (drawing.current.x + p.x) / 2, y: (drawing.current.y + p.y) / 2 };
              ctx.beginPath();
              ctx.moveTo(drawing.current.x, drawing.current.y);
              ctx.quadraticCurveTo(drawing.current.x, drawing.current.y, mid.x, mid.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              drawing.current = p;
            }}
            onPointerUp={() => (drawing.current = null)}
            onPointerCancel={() => (drawing.current = null)}
            aria-label="Draw your signature"
          />
          {drawErr && (
            <p role="alert" className="mt-2 text-sm text-bad">{drawErr}</p>
          )}
          <div className="mt-1 flex justify-between text-xs text-muted">
            <span>Draw with your mouse, finger or stylus. Prefer the keyboard? Use Type.</span>
            <button
              type="button"
              className="font-medium text-brand"
              onClick={() => {
                const c = canvas.current!;
                c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                inked.current = false;
                setHasInk(false);
                setDrawErr(null);
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" onClick={tab === "type" ? adoptTyped : adoptDrawn} disabled={tab === "type" ? !text.trim() : !hasInk}>
          Adopt {mode === "initials" ? "initials" : "signature"}
        </Button>
      </div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // What opened the dialog, read on the first render: by the time effects run, content with autoFocus (the
  // publish checkbox, a field's text input) has already taken focus, and restoring to that would lose it.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // Focus moves into the dialog when it opens (its first input, otherwise the dialog itself, so its title
  // is read) and back to whatever opened it when it closes.
  useEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea, select') ?? el).focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  // Tab and Shift+Tab stay inside the dialog while it is open.
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0],
      last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} onKeyDown={trap} role="dialog" aria-modal="true" aria-label={title} className={cx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl outline-none sm:rounded-2xl sm:p-6", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="-m-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-muted hover:text-ink" aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
