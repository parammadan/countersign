#!/usr/bin/env node
// Regenerates the PDF versions of the document-understanding cases (fixtures/understanding/*.json with
// "pdf": true), so the PDF path (extractPdf -> pageLines) is measured as well as the plain-text path.
//
//   node scripts/make-understanding.mjs && npx vitest run test/understand-eval.test.ts
//
// The JSON files are the source of truth (hand-written ground truth); only the PDFs are generated.
// Synthetic agreements only: every firm, person and amount is invented. Output is deterministic.
//
// Layout: one column unless a case says "layout": "two-column". Then the first line of page 1 is a
// full-width heading, the next "columnSplit" lines fill the left column, the rest the right column, and
// the two columns share baselines (so text extraction interleaves them row by row, like a real brochure).
// Lines that start with "Page N of M" are drawn in the footer.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, PageSizes, rgb } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "fixtures", "understanding");
const [W, H] = PageSizes.Letter;
const MARGIN = 60;
const SIZE = 10.5;
const LEAD = 15;
const FIXED_DATE = new Date("2026-11-01T12:00:00Z");
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.4, 0.4, 0.4);

function wrap(text, font, size, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(next, size) > width) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

const isFooter = (l) => /^Page \d+ of \d+/.test(l.trim());

async function render(c) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(c.title ?? c.name);
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const two = c.layout === "two-column";
  c.pages.forEach((text, pi) => {
    const page = pdf.addPage([W, H]);
    let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const footers = lines.filter(isFooter);
    lines = lines.filter((l) => !isFooter(l));
    let y = H - MARGIN;
    const heading = pi === 0 && lines.length && lines[0] === lines[0].toUpperCase() ? lines.shift() : null;
    if (heading) {
      page.drawText(heading, { x: MARGIN, y: y - 14, size: 16, font: bold, color: BLACK });
      y -= 40;
    }
    if (two) {
      const split = c.columnSplit;
      const left = lines.slice(0, split);
      const right = lines.slice(split);
      const rows = Math.max(left.length, right.length);
      for (let i = 0; i < rows; i++) {
        const ty = y - 9 - i * 14;
        if (left[i]) page.drawText(left[i], { x: MARGIN, y: ty, size: 9, font, color: BLACK });
        if (right[i]) page.drawText(right[i], { x: 330, y: ty, size: 9, font, color: BLACK });
      }
    } else {
      for (const l of lines) {
        for (const w of wrap(l, font, SIZE, W - 2 * MARGIN)) {
          page.drawText(w, { x: MARGIN, y: y - SIZE, size: SIZE, font, color: BLACK });
          y -= LEAD;
        }
        y -= 4;
      }
    }
    footers.forEach((f, i) => page.drawText(f, { x: MARGIN, y: 36 - i * 11, size: 8, font, color: GREY }));
  });
  return pdf.save({ useObjectStreams: false });
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
let n = 0;
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  if (!c.pdf) continue;
  fs.writeFileSync(path.join(DIR, `${c.name}.pdf`), await render(c));
  n++;
}
console.log(`wrote ${n} PDFs to fixtures/understanding`);
