"use client";

import { useEffect, useRef, useState } from "react";
import { Dancing_Script, Caveat } from "next/font/google";
import { Button, cx, inputCls } from "./ui";

const f1 = Dancing_Script({ subsets: ["latin"], weight: ["600"] });
const f2 = Caveat({ subsets: ["latin"], weight: ["600"] });
const FONTS = [f1.style.fontFamily, f2.style.fontFamily];

export type Adopted = { png: string; method: "drawn" | "typed" };

function trim(c: HTMLCanvasElement): string | null {
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
  const pad = 8;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
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
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || tab !== "draw") return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(r.width * dpr);
    c.height = Math.floor(r.height * dpr);
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    setHasInk(false);
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
    const png = trim(c);
    if (png) onAdopt({ png, method: "typed" });
  }

  function adoptDrawn() {
    if (!canvas.current || !hasInk) return;
    const png = trim(canvas.current);
    if (png) onAdopt({ png, method: "drawn" });
  }

  return (
    <div>
      <div className="mb-4 inline-flex rounded-lg border border-line p-0.5 text-sm">
        {(["type", "draw"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={cx("rounded-md px-3 py-1.5", tab === t ? "bg-brand text-white" : "text-muted")}>
            {t === "type" ? "Type" : "Draw"}
          </button>
        ))}
      </div>
      {tab === "type" ? (
        <div className="space-y-3">
          <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={mode === "initials" ? 6 : 80} aria-label={mode === "initials" ? "Your initials" : "Your full name"} />
          <div className="grid gap-2 sm:grid-cols-2">
            {FONTS.map((fam, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setFont(i)}
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
          <div className="mt-1 flex justify-between text-xs text-muted">
            <span>Draw with your mouse, finger or stylus.</span>
            <button
              type="button"
              className="font-medium text-brand"
              onClick={() => {
                const c = canvas.current!;
                c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                setHasInk(false);
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

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xl leading-none text-muted hover:text-ink" aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
