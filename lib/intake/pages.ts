// Extracted PDF text (lib/pdf/extract) -> one string per page, lines in reading order, for the intake rules.
// Unlike lib/understand/text pageLines, characters are kept exactly as extracted (no NFKC, invisible characters
// kept): the intake's injection quarantine reads them itself, and removing a zero-width space would join words
// ("previous<ZWSP>instructions"). Lines are the text items on one baseline, left to right, top to bottom.
import type { Extracted } from "../pdf/extract";

export function pagesFromExtraction(ex: Extracted): string[] {
  return ex.pages.map((p) => {
    const items = p.items.filter((i) => i.str.length > 0);
    const rows: { base: number; parts: { x: number; w: number; s: string }[] }[] = [];
    for (const it of [...items].sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x)) {
      const base = it.y + it.h * 0.8;
      const tol = Math.max(2, it.h * 0.35);
      const row = rows.find((r) => Math.abs(r.base - base) <= tol);
      if (row) row.parts.push({ x: it.x, w: it.w, s: it.str });
      else rows.push({ base, parts: [{ x: it.x, w: it.w, s: it.str }] });
    }
    rows.sort((a, b) => a.base - b.base);
    return rows
      .map((r) => {
        let out = "";
        let end = -Infinity;
        for (const q of r.parts.sort((a, b) => a.x - b.x)) {
          if (out && q.x - end > 1.5 && !out.endsWith(" ") && !q.s.startsWith(" ")) out += " ";
          out += q.s;
          end = q.x + q.w;
        }
        return out;
      })
      .filter((l) => l.trim().length > 0)
      .join("\n");
  });
}
