import type { Extracted } from "./extract";

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
const KEEP_UPPER = /^(LLC|LLP|LP|INC|MSA|SOW|NDA|AI|IT|US|USA|UK|II|III|IV)$/;

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => {
      const bare = w.replace(/[^a-z]/gi, "").toUpperCase();
      if (KEEP_UPPER.test(bare)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("");
}

const DOC_WORDS = /\b(agreement|contract|engagement|letter|terms|statement of work|order form|retainer|proposal|addendum|schedule|conditions|subscription)\b/i;

// The document's own title: the biggest line near the top of page 1, if it stands out from the body text.
export function documentTitle(ex: Extracted): string | null {
  const p = ex.pages[0];
  if (!p || !p.items.length) return null;
  const sizes = p.items.filter((i) => i.str.trim()).map((i) => i.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 10;
  const lines = new Map<number, { y: number; size: number; parts: { x: number; s: string }[] }>();
  for (const it of p.items) {
    if (!it.str.trim() || it.y > p.height * 0.45) continue;
    const key = Math.round(it.y / 3);
    const l = lines.get(key) ?? { y: it.y, size: 0, parts: [] };
    l.size = Math.max(l.size, it.size);
    l.parts.push({ x: it.x, s: it.str });
    lines.set(key, l);
  }
  const all = [...lines.values()]
    .map((l) => ({ ...l, text: l.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(" ").replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length >= 4 && l.text.length <= 90 && /[a-z]{3}/i.test(l.text) && !/^(page|confidential|draft)\b/i.test(l.text));
  // Prefer a line that reads like a title ("... Agreement", "Engagement Letter") over a letterhead.
  const titled = all.filter((l) => DOC_WORDS.test(l.text) && l.text.split(" ").length <= 12 && !/[.;]$/.test(l.text) && (l.size >= body * 1.1 || l.text === l.text.toUpperCase()));
  const cands = (titled.length ? titled : []).sort((a, b) => b.size - a.size || a.y - b.y);
  if (!cands.length) return null;
  const top = cands[0];
  // a title split over two lines at the same size ("CLIENT SERVICES" / "AGREEMENT")
  const next = all.find((c) => c !== top && Math.abs(c.size - top.size) < 0.5 && c.y > top.y && c.y - top.y < top.size * 1.8 && c.text.split(" ").length <= 6);
  let t = next && !DOC_WORDS.test(top.text.split(" ").slice(-1)[0]) ? `${top.text} ${next.text}` : top.text;
  t = t.replace(/[\s:–-]+$/, "");
  if (t.length > 90) return null;
  return t === t.toUpperCase() ? titleCase(t) : t;
}
