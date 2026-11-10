// Reading order text per page, from the same extraction the field detector uses (lib/pdf/extract.ts).
import type { Extracted } from "../pdf/extract";

export type PageLines = { page: number; lines: string[]; textLayer?: boolean };

// format and default-ignorable characters (soft hyphens, zero-width, bidi controls and isolates, tag characters,
// variation selectors): invisible on the page, but they change what the text "says"
// ("$5<zero-width space>00" reads as $5). Removed once here, so analyzers and the evidence check see the same text.
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const clean = (s: string) => s.normalize("NFKC").replace(INVISIBLE, "");

/** Group text items into lines (same baseline, left to right), top to bottom. Page numbers start at 1. */
export function pageLines(ex: Extracted): PageLines[] {
  const pages: PageLines[] = ex.pages.map((p) => {
    const items = p.items.map((i) => ({ ...i, str: clean(i.str) })).filter((i) => i.str.trim().length > 0);
    items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x);
    const rows: { base: number; parts: { x: number; w: number; s: string }[] }[] = [];
    // items arrive in baseline order, so rows are created in baseline order too and every existing row's base is <=
    // this item's: the first row within tolerance is the first with base >= base - tol, found by binary search
    // (same row as a linear scan, without its quadratic cost on pages of many lines). Non-finite positions keep the scan.
    const finite = items.every((i) => Number.isFinite(i.y + i.h * 0.8));
    const firstWithin = (base: number, tol: number) => {
      if (!finite) return rows.find((r) => Math.abs(r.base - base) <= tol);
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].base < base - tol) lo = mid + 1;
        else hi = mid;
      }
      const r = rows[lo];
      return r && Math.abs(r.base - base) <= tol ? r : undefined;
    };
    for (const it of items) {
      const base = it.y + it.h * 0.8;
      const tol = Math.max(2, it.h * 0.35);
      const row = firstWithin(base, tol);
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
    return { page: p.index + 1, lines, textLayer: items.length > 0 };
  });
  return dropRunningLines(pages);
}

const PAGE_NUMBER = /^(?:page\s+)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$|^-\s*\d{1,3}\s*-$/i;

/** Headers and footers repeated on most pages, and bare page numbers, aren't part of what the agreement says. */
export function dropRunningLines(pages: PageLines[]): PageLines[] {
  const counts = new Map<string, number>();
  if (pages.length >= 3) for (const p of pages) for (const l of new Set(p.lines.map((x) => x.toLowerCase()))) counts.set(l, (counts.get(l) ?? 0) + 1);
  const running = (l: string) => l.length <= 120 && (counts.get(l.toLowerCase()) ?? 0) >= Math.max(3, Math.ceil(pages.length * 0.6));
  return pages.map((p) => ({ ...p, lines: p.lines.filter((l) => !PAGE_NUMBER.test(l.trim()) && !running(l)) }));
}

/** One page as running text (lines joined by spaces), the form quotes are checked against. */
export const pageText = (p: PageLines) => p.lines.join(" ");

/** Pages built from plain strings, for tests and synthetic agreements: one string per page, lines split on \n. */
export function linesFromText(pages: string[]): PageLines[] {
  return pages.map((t, i) => ({ page: i + 1, lines: t.split("\n").map((l) => clean(l).replace(/\s+/g, " ").trim()).filter(Boolean), textLayer: t.trim().length > 0 }));
}
