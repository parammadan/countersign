// Pulls every text item out of a PDF with page coordinates (points, top-left origin).
// Runs in Node via the pdfjs legacy build. No rendering, no native deps.

export type TextItem = { str: string; x: number; y: number; w: number; h: number; size: number };
export type HLine = { x0: number; x1: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type PageText = { index: number; width: number; height: number; items: TextItem[]; hlines: HLine[]; boxes: Box[] };
export type Extracted = { pages: PageText[]; textChars: number };

// Helvetica AFM widths (1/1000 em) for a better per-character x estimate inside a text item.
const W: Record<string, number> = { " ": 278, _: 556, ".": 278, ",": 278, ":": 278, ";": 278, "-": 333, "(": 333, ")": 333, "/": 278, "$": 556, "'": 191, '"': 355, "i": 222, "j": 222, "l": 222, "f": 278, "t": 278, "r": 333, "m": 833, "w": 722, "I": 278, "J": 500, "M": 833, "W": 944 };
export function charWeight(c: string): number {
  if (W[c] !== undefined) return W[c];
  if (c >= "0" && c <= "9") return 556;
  if (c >= "A" && c <= "Z") return 667;
  if (c >= "a" && c <= "z") return 520;
  return 556;
}

// pdfjs ops we care about for drawn signature lines
const OPS = { constructPath: 91, rectangle: 19, moveTo: 13, lineTo: 14, stroke: 20, fill: 22, eoFill: 23 };

export async function extractPdf(data: Uint8Array): Promise<Extracted> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages: PageText[] = [];
  let textChars = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
        if (!it.str || !it.transform) continue;
        const m = pdfjs.Util.transform(vp.transform, it.transform) as number[];
        const size = Math.hypot(m[2], m[3]) || it.height || 10;
        const x = m[4];
        const baseline = m[5];
        items.push({ str: it.str, x, y: baseline - size * 0.8, w: it.width ?? 0, h: size, size });
        textChars += it.str.trim().length;
      }
      let hlines: HLine[] = [];
      let boxes: Box[] = [];
      try {
        ({ hlines, boxes } = await drawnLines(page, vp.transform, pdfjs.Util.transform as (a: number[], b: number[]) => number[]));
      } catch {
        hlines = [];
        boxes = [];
      }
      pages.push({ index: p - 1, width: vp.width, height: vp.height, items, hlines, boxes });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return { pages, textChars };
}

// Find thin horizontal strokes/rects (signature lines drawn as vectors, e.g. DOCX borders).
async function drawnLines(
  page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }> },
  vpT: number[],
  mul: (a: number[], b: number[]) => number[],
): Promise<{ hlines: HLine[]; boxes: Box[] }> {
  const ol = await page.getOperatorList();
  const out: HLine[] = [];
  const boxes: Box[] = [];
  // Track CTM through save/restore/transform
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const pt = (x: number, y: number) => {
    const m = mul(vpT, ctm);
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as unknown[];
    if (fn === 10) stack.push(ctm); // save
    else if (fn === 11) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]; // restore
    else if (fn === 12) ctm = mul(ctm, args as number[]); // transform
    else if (fn === OPS.constructPath) {
      collectPath(args, pt, out, boxes);
    }
  }
  // dedupe near-identical squares (fill + stroke of the same box)
  const uniq: Box[] = [];
  for (const b of boxes) if (!uniq.some((u) => Math.abs(u.x - b.x) < 2 && Math.abs(u.y - b.y) < 2)) uniq.push(b);
  return { hlines: out, boxes: uniq };
}

function pushBox(boxes: Box[], pts: number[][]) {
  if (pts.length < 4) return;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const w = Math.max(...xs) - x,
    h = Math.max(...ys) - y;
  if (w >= 5 && w <= 16 && h >= 5 && h <= 16 && Math.abs(w - h) < 2.5) boxes.push({ x, y, w, h });
}

function collectPath(args: unknown[], pt: (x: number, y: number) => number[], out: HLine[], boxes: Box[]) {
  // pdfjs >=5: args = [paintOp, [Float32Array path], minMax]; path encodes [op, ...coords]
  // pdfjs <5: args = [ops[], coords[], minMax]
  const push = (ax: number, ay: number, bx: number, by: number) => {
    const [x0, y0] = pt(ax, ay);
    const [x1, y1] = pt(bx, by);
    if (Math.abs(y0 - y1) < 1.5 && Math.abs(x1 - x0) > 60) {
      out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y: (y0 + y1) / 2 });
    }
  };
  const a0 = args[0];
  const a1 = args[1];
  if (Array.isArray(a0) && Array.isArray(a1)) {
    const ops = a0 as number[];
    const c = a1 as number[];
    let k = 0;
    let cx = 0,
      cy = 0;
    for (const op of ops) {
      if (op === OPS.rectangle) {
        const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]];
        k += 4;
        if (Math.abs(h) < 2.5) push(x, y + h / 2, x + w, y + h / 2);
        else pushBox(boxes, [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]);
      } else if (op === OPS.moveTo) {
        cx = c[k];
        cy = c[k + 1];
        k += 2;
      } else if (op === OPS.lineTo) {
        push(cx, cy, c[k], c[k + 1]);
        cx = c[k];
        cy = c[k + 1];
        k += 2;
      } else if (op === 15) k += 6;
      else if (op === 16 || op === 17) k += 4;
    }
    return;
  }
  const pathArr = Array.isArray(a1) ? (a1[0] as ArrayLike<number> | undefined) : undefined;
  if (!pathArr || typeof pathArr.length !== "number") return;
  // pdfjs 5 DrawOPS: moveTo=0, lineTo=1, curveTo=2, quadraticCurveTo=3, closePath=4
  let i = 0;
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  let sub: number[][] = [];
  while (i < pathArr.length) {
    const op = pathArr[i++];
    if (op === 0) {
      pushBox(boxes, sub);
      cx = sx = pathArr[i++];
      cy = sy = pathArr[i++];
      sub = [pt(cx, cy)];
    } else if (op === 1) {
      const x = pathArr[i++],
        y = pathArr[i++];
      push(cx, cy, x, y);
      cx = x;
      cy = y;
      sub.push(pt(x, y));
    } else if (op === 2) {
      i += 4;
      cx = pathArr[i++];
      cy = pathArr[i++];
    } else if (op === 3) {
      i += 2;
      cx = pathArr[i++];
      cy = pathArr[i++];
    } else if (op === 4) {
      // closePath: thin rectangles come through as 4 lineTos + close; the long edges are caught above
      pushBox(boxes, sub);
      sub = [];
      cx = sx;
      cy = sy;
    } else break;
  }
  pushBox(boxes, sub);
}
