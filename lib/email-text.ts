// The plain-text alternative sent alongside every HTML email (HTML-only mail is a common spam signal).
// Dependency-free and only for the HTML this app writes (lib/email.ts layout): links stay usable as "label: URL".
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", apos: "'", nbsp: " " };

function decode(s: string) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp);/gi, (_, e: string) => ENTITIES[e.toLowerCase()]);
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "");

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, dq: string | undefined, sq: string | undefined, inner: string) => {
      // kept escaped here: the whole text is decoded once at the end
      const href = (dq ?? sq ?? "").trim();
      const label = strip(inner).replace(/\s+/g, " ").trim();
      if (!href || /^(javascript|data):/i.test(decode(href))) return label;
      return !label || label === href ? href : `${label}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)\s*>/gi, "\n\n")
    .replace(/<\/(p|div|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<p\b[^>]*>/gi, "\n\n")
    .replace(/<(div|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi, "\n");
  s = decode(strip(s));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
