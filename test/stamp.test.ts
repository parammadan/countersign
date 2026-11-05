// Stamps must land where the editor showed them, whatever the page's /Rotate and crop box.
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { extractPdf } from "../lib/pdf/extract";
import { stampFields, type StampValue } from "../lib/pdf/stamp";
import type { Field } from "../lib/fields";

async function pageWithAnchor(rot: number, crop = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText("ANCHOR", { x: 100, y: 700, size: 12, font });
  if (crop) p.setCropBox(20, 30, 560, 740);
  p.setRotation(degrees(rot));
  return doc.save();
}

describe("stamping", () => {
  for (const rot of [0, 90, 180, 270]) {
    for (const crop of [false, true]) {
      it(`places text below an anchor on a page rotated ${rot}°${crop ? " with a crop box" : ""}`, async () => {
        const pdf = await pageWithAnchor(rot, crop);
        const ex = await extractPdf(pdf);
        const a = ex.pages[0].items.find((i) => i.str === "ANCHOR")!;
        expect(a).toBeTruthy();
        // the editor would place a field 40pt below the anchor in viewport coordinates
        const f: Field = { id: "f1", type: "text", role: "client", page: 0, x: a.x, y: a.y + 40, w: 200, h: 16, label: "t", required: false };
        const out = await stampFields(pdf, [f], new Map<string, StampValue>([["f1", { kind: "text", text: "STAMPED" }]]));
        const after = await extractPdf(out);
        const st = after.pages[0].items.find((i) => i.str === "STAMPED");
        expect(st, "stamp is on the page and readable").toBeTruthy();
        expect(Math.abs(st!.x - (a.x + 1))).toBeLessThan(3);
        expect(st!.y).toBeGreaterThan(f.y - 2);
        expect(st!.y + st!.h).toBeLessThan(f.y + f.h + 3);
        // and it reads left-to-right, upright, in the viewer
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const d = await pdfjs.getDocument({ data: new Uint8Array(out), verbosity: 0 }).promise;
        const pg = await d.getPage(1);
        const vp = pg.getViewport({ scale: 1 });
        const it = (await pg.getTextContent()).items.find((i) => "str" in i && i.str === "STAMPED") as { transform: number[] };
        const m = pdfjs.Util.transform(vp.transform, it.transform) as number[];
        expect(m[0]).toBeGreaterThan(0);
        expect(Math.abs(m[1])).toBeLessThan(0.01);
        expect(m[3]).toBeLessThan(0); // viewport y grows downward: glyph "up" points up the screen
        await d.destroy();
      });
    }
  }
});
