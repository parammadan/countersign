// Reading order text per page, from the same extraction the field detector uses (lib/pdf/extract.ts).
import type { Extracted } from "../pdf/extract";

export type PageLines = { page: number; lines: string[] };

/** Group text items into lines (same baseline, left to right), top to bottom. Page numbers start at 1. */
export function pageLines(ex: Extracted): PageLines[] {
  return ex.pages.map((p) => {
    const items = p.items.filter((i) => i.str.trim().length > 0).slice();
    items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x);
    const rows: { base: number; parts: { x: number; w: number; s: string }[] }[] = [];
    for (const it of items) {
      const base = it.y + it.h * 0.8;
      const tol = Math.max(2, it.h * 0.35);
      const row = rows.find((r) => Math.abs(r.base - base) <= tol);
      if (row) row.parts.push({ x: it.x, w: it.w, s: it.str });
      else rows.push({ base, parts: [{ x: it.x, w: it.w, s: it.str }] });
    }
    rows.sort((a, b) => a.base - b.base);
    const lines = rows
      .map((r) => {
        const parts = r.parts.sort((a, b) => a.x - b.x);
        let out = "";
        let end = -Infinity;
        for (const q of parts) {
          // a visible gap between items is a space; touching items are one word
          if (out && q.x - end > 1.5 && !out.endsWith(" ") && !q.s.startsWith(" ")) out += " ";
          out += q.s;
          end = q.x + q.w;
        }
        return out.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);
    return { page: p.index + 1, lines };
  });
}

/** One page as running text (lines joined by spaces), the form quotes are checked against. */
export const pageText = (p: PageLines) => p.lines.join(" ");

/** Pages built from plain strings, for tests and synthetic agreements: one string per page, lines split on \n. */
export function linesFromText(pages: string[]): PageLines[] {
  return pages.map((t, i) => ({ page: i + 1, lines: t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean) }));
}
