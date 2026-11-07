// A workspace picks any brand colour, but it's used for white text on buttons (Review and sign, Download, the
// email's call to action) and for brand-coloured text on white. Both need 4.5:1 (WCAG AA). A colour that's
// already readable is kept as chosen; a lighter one is darkened, keeping its hue, just enough to pass. This is
// applied where the colour is rendered, so workspaces that saved a light colour before are covered too.
import { BRAND } from "./brand";

const HEX = /^#[0-9a-f]{6}$/i;

function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG contrast ratio of a #rrggbb colour against white. */
export function contrastWithWhite(hex: string) {
  const [r, g, b] = rgb(hex);
  const l = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (l + 0.05);
}

/** The brand colour to render: as chosen when readable, else the same hue darkened to at least 4.5:1. */
export function readableBrand(hex: string | null | undefined, min = 4.5): string {
  if (!hex || !HEX.test(hex)) return BRAND.color;
  if (contrastWithWhite(hex) >= min) return hex.toLowerCase();
  const [r, g, b] = rgb(hex);
  for (let k = 0.98; k > 0; k -= 0.02) {
    const out = "#" + [r, g, b].map((c) => Math.round(c * k).toString(16).padStart(2, "0")).join("");
    if (contrastWithWhite(out) >= min) return out;
  }
  return "#000000";
}
