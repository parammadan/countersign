// Extracted PDF text (lib/pdf/extract) -> one string per page, lines in reading order, for the intake rules.
// Unlike lib/understand/text pageLines, characters are kept exactly as extracted (no NFKC, invisible characters
// kept): the intake's injection quarantine reads them itself, and removing a zero-width space would join words
// ("previous<ZWSP>instructions"). Lines are the text items on one baseline, left to right, top to bottom.
//
// Bounded work: rows are found through baseline buckets (not a scan of every row per item), and reading stops after
// MAX_PDF_CHARS characters (just over the intake's own 500,000-character limit, so the intake reports the truncation).
import type { Extracted } from "../pdf/extract";

export const MAX_PDF_CHARS = 500_001;
const BUCKET = 2;

export function pagesFromExtraction(ex: Extracted): string[] {
  let budget = MAX_PDF_CHARS;
  const out: string[] = [];
  for (const p of ex.pages) {
    if (budget <= 0) break;
    const items: typeof p.items = [];
    for (const i of p.items) {
      if (!i.str.length) continue;
      if (budget <= 0) break;
      items.push(i.str.length > budget ? { ...i, str: i.str.slice(0, budget) } : i);
      budget -= Math.min(i.str.length, budget);
    }
    type Row = { base: number; parts: { x: number; w: number; s: string }[] };
    const rows: Row[] = [];
    const buckets = new Map<number, Row[]>();
    for (const it of items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x)) {
      const base = it.y + it.h * 0.8;
      const tol = Math.max(2, it.h * 0.35);
      const k = Math.round(base / BUCKET);
      const reach = Math.ceil(tol / BUCKET) + 1;
      let row: Row | undefined;
      for (let d = -reach; d <= reach && !row; d++) row = buckets.get(k + d)?.find((r) => Math.abs(r.base - base) <= tol);
      if (row) row.parts.push({ x: it.x, w: it.w, s: it.str });
      else {
        row = { base, parts: [{ x: it.x, w: it.w, s: it.str }] };
        rows.push(row);
        buckets.set(k, [...(buckets.get(k) ?? []), row]);
      }
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
        .filter((l) => l.trim().length > 0)
        .join("\n"),
    );
  }
  return out;
}
