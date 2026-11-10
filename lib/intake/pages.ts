// Extracted PDF text (lib/pdf/extract) -> one string per page, lines in reading order, for the intake rules.
// Unlike lib/understand/text pageLines, characters are kept exactly as extracted (no NFKC, invisible characters
// kept): the intake's injection quarantine reads them itself, and removing a zero-width space would join words
// ("previous<ZWSP>instructions"). Lines are the text items on one baseline, left to right, top to bottom.
//
// Bounded work: items are sorted by baseline and each is compared with the last row only (the tolerance is clamped,
// so a huge font size can't widen it), items with non-finite coordinates go on lines of their own, and reading stops after
// MAX_PDF_CHARS characters (just over the intake's own 500,000-character limit, so the intake reports the truncation).
import type { Extracted } from "../pdf/extract";

export const MAX_PDF_CHARS = 500_001;
const MAX_TOL = 12;
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

export function pagesFromExtraction(ex: Extracted): string[] {
  let budget = MAX_PDF_CHARS;
  const out: string[] = [];
  for (const p of ex.pages) {
    if (budget <= 0) break;
    const items: typeof p.items = [];
    // text whose position can't be read (a hostile text matrix gives NaN or infinite coordinates) is kept, each item
    // on a line of its own after the page's other lines, so the rules still read it
    const stray: string[] = [];
    for (const i of p.items) {
      if (!i.str.length) continue;
      if (budget <= 0) break;
      const str = i.str.length > budget ? i.str.slice(0, budget) : i.str;
      budget -= str.length;
      if (finite(i.x) && finite(i.y) && finite(i.h) && finite(i.w)) items.push(str === i.str ? i : { ...i, str });
      else stray.push(str);
    }
    type Row = { base: number; parts: { x: number; w: number; s: string }[] };
    const rows: Row[] = [];
    // items arrive sorted by baseline, so a line's items are adjacent: compare each with the last row only (linear).
    // The tolerance is clamped, so a huge font size from a hostile text matrix can't widen it.
    for (const it of items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x)) {
      const base = it.y + it.h * 0.8;
      const tol = Math.min(MAX_TOL, Math.max(2, it.h * 0.35));
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.base - base) <= tol) last.parts.push({ x: it.x, w: it.w, s: it.str });
      else rows.push({ base, parts: [{ x: it.x, w: it.w, s: it.str }] });
    }
    rows.sort((a, b) => a.base - b.base);
    out.push(
      rows
        .map((r) => {
          let line = "";
          let end = -Infinity;
          for (const q of r.parts.sort((a, b) => a.x - b.x)) {
            if (line && q.x - end > 1.5 && !line.endsWith(" ") && !q.s.startsWith(" ")) line += " ";
            line += q.s;
            end = q.x + q.w;
          }
          return line;
        })
        .concat(stray)
        .filter((l) => l.trim().length > 0)
        .join("\n"),
    );
  }
  return out;
}
