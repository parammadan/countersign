"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PageSize } from "@/lib/fields";

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> };
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void>; cancel: () => void };
};

let lib: Promise<{ getDocument: (o: { url: string; withCredentials?: boolean }) => { promise: Promise<PdfDoc> } }> | null = null;
function pdfjs() {
  if (!lib) {
    lib = import("pdfjs-dist").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return m as unknown as { getDocument: (o: { url: string }) => { promise: Promise<PdfDoc> } };
    });
  }
  return lib;
}

export function PdfPages({
  url,
  pages,
  overlay,
  onPageClick,
  className,
}: {
  url: string;
  pages: PageSize[];
  overlay?: (page: number, scale: number) => ReactNode;
  onPageClick?: (page: number, x: number, y: number) => void;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    let d: PdfDoc | null = null;
    pdfjs()
      .then((p) => p.getDocument({ url }).promise)
      .then((x) => {
        d = x;
        if (alive) setDoc(x);
        else x.destroy();
      })
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => {
      alive = false;
      d?.destroy();
    };
  }, [url]);

  return (
    <div ref={wrap} className={className}>
      {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Couldn&apos;t load the document: {err}</div>}
      <div className="space-y-4">
        {pages.map((p, i) => (
          <PageView key={i} doc={doc} index={i} size={p} width={width} overlay={overlay} onPageClick={onPageClick} />
        ))}
      </div>
    </div>
  );
}

function PageView({
  doc,
  index,
  size,
  width,
  overlay,
  onPageClick,
}: {
  doc: PdfDoc | null;
  index: number;
  size: PageSize;
  width: number;
  overlay?: (page: number, scale: number) => ReactNode;
  onPageClick?: (page: number, x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const [rendered, setRendered] = useState(false);
  const scale = width ? width / size.width : 0;

  useEffect(() => {
    const el = box.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!doc || !width || !visible || !canvas.current) return;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;
    let alive = true;
    doc.getPage(index + 1).then((page) => {
      if (!alive || !canvas.current) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const vp = page.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext("2d")!;
      task = page.render({ canvasContext: ctx, viewport: vp, canvas: c });
      task.promise.then(() => alive && setRendered(true)).catch(() => {});
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, width, visible, index, scale]);

  return (
    <div
      ref={box}
      data-page={index}
      className="relative mx-auto overflow-hidden rounded-sm bg-white shadow-[0_1px_3px_rgba(16,24,40,.12),0_0_0_1px_rgba(16,24,40,.06)]"
      style={{ width: "100%", aspectRatio: `${size.width} / ${size.height}` }}
      onClick={(e) => {
        if (!onPageClick || !scale) return;
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.pagebg) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPageClick(index, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
      }}
    >
      <canvas ref={canvas} data-pagebg="1" className="absolute inset-0 h-full w-full" />
      {!rendered && <div data-pagebg="1" className="absolute inset-0 animate-pulse bg-gray-50" />}
      {scale > 0 && overlay?.(index, scale)}
      <div className="pointer-events-none absolute right-2 bottom-1 text-[10px] text-gray-400">{index + 1}</div>
    </div>
  );
}

export function pct(v: number, of: number) {
  return `${(v / of) * 100}%`;
}
