import { LATIN_FORM, SAFE_WITH_LATIN } from "./safety";
import { PLACEHOLDER_TYPES, type Issue, type Params, type Placeholder, type PlaceholderType } from "./types";

const PATH = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,5}$/;
const TOKEN = /\{\{([^{}]*)\}\}/g;
const MAX_TEXT = 500;
const MAX_MULTILINE = 2_000;
// Every character a renderer, editor or splitter may treat as a line or paragraph break: LF, VT, FF, CR,
// the information separators U+001C-U+001E (Python's splitlines), NEL, LINE and PARAGRAPH SEPARATOR.
const LINE_BREAK = /[\n\v\f\r\u001c-\u001e\u0085\u2028\u2029]/;
// The same set without LF, which is what a declared `multiline` value may contain.
const NON_LF_BREAK = /[\v\f\r\u001c-\u001e\u0085\u2028\u2029]/;
// Placeholder delimiters, checked also after compatibility normalisation (full-width and small-form braces).
const PLACEHOLDER_SYNTAX = /\{\{|\}\}/;
// A number given for a text placeholder must print as plain digits: no NaN, Infinity or exponent (1e+21).
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
// Links do not belong in a parameter value (a party name, an address): they are phishing targets once rendered.
const LINK = /\b(?:https?|ftp|file|mailto)\s*:|(?:^|[^\p{L}\p{N}.-])www\.|(?:^|[\s(<"'[])\/\/[^\s/]/iu;
const LATIN = /\p{Script=Latin}/u;
// Scripts whose letters nearly all read as Latin: a value written only in them imitates Latin text.
const IMITATING_SCRIPT = /[\p{Script=Lisu}\p{Script=Coptic}\p{Script=Cherokee}]/u;
// Cyrillic, Greek and Cherokee letters that read as Latin ones. A value written only in these imitates Latin text.
const LATIN_LOOKALIKES = new Set([..."\u0410\u0412\u0415\u0405\u0406\u0408\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0423\u04ae\u051a\u051c\u0430\u0435\u04bb\u0456\u0458\u04cf\u043e\u0440\u0441\u0455\u0443\u04af\u0445\u0501\u051b\u051d" + "\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u03bf\u03b9" + "\u13aa\u13f4\u13df\u13a0\u13ac\u13bb\u13a5\u13e6\u13de\u13b7\u13c1\u13be\u13e2\u13d2\u13da\u13a2\u13d9\u13d4\u13b3\u13bd\u13c3"]);

/**
 * Look-alike check for one value: Latin mixed with letters of a look-alike script (Cyrillic, Greek, Lisu...: "Maple" with a
 * Cyrillic U+0435), or a value written only in letters that imitate Latin ones ("ABC" spelled in Cyrillic), is refused.
 */
export function lookalikeIssue(s: string): string | null {
  // Letter forms that compatibility-normalise to something else (mathematical, full-width, Roman numerals, long s,
  // digraphs, modifier/superscript letters...) are refused, as are symbols that normalise to a letter (circled
  // letters "Ⓐcme"). Explicit exceptions only: the ligatures ﬀ-ﬆ (they display as the letters they stand for),
  // half-width kana, µ ℓ directly after a figure ("5 µm", "2 ℓ"), and ª º after a figure or "n" ("1ª", "nº 123").
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const n = c.normalize("NFKC");
    if (n === c.normalize("NFC")) continue; // only a canonical difference (e.g. Devanagari nukta letters): same text
    const letterish = /[\p{L}\p{Nl}]/u.test(c) || (/\p{S}/u.test(c) && /\p{L}/u.test(n));
    if (!letterish) continue;
    if (/[\ufb00-\ufb06\uff65-\uff9f\u2122\u2120\u2103]/u.test(c)) continue; // + ™ ℠ ℃: shown as symbols, not letters
    const before = chars.slice(Math.max(0, i - 3), i).join(""); // 3 characters cover "xN.º"; bounded work
    if (/[\u00b5\u2113]/u.test(c) && /\d\s?$/u.test(before)) continue;
    if (/[\u00aa\u00ba]/u.test(c) && /(?:\d|(?:^|[^\p{L}])[nN]\.?)$/u.test(before)) continue;
    return "uses letter forms that imitate other letters";
  }
  if (chars.some((c) => /[\p{L}\p{Nl}]/u.test(c) && LATIN_FORM.test(c))) return "uses letter forms that imitate other letters";
  const letters = s.match(/\p{L}/gu) ?? [];
  if (LATIN.test(s) && letters.some((c) => !SAFE_WITH_LATIN.test(c))) return "mixes Latin with letters of a look-alike script";
  if (letters.length && !LATIN.test(s) && letters.every((c) => LATIN_LOOKALIKES.has(c) || IMITATING_SCRIPT.test(c))) return "is written only in letters that imitate Latin ones";
  return null;
}

/** True when the text, or its NFKC form, contains `{{` or `}}`. */
export function hasPlaceholderSyntax(s: string): boolean {
  return PLACEHOLDER_SYNTAX.test(s) || PLACEHOLDER_SYNTAX.test(s.normalize("NFKC"));
}

export interface ParsedBody { placeholders: Placeholder[]; issues: Issue[] }

/** Finds `{{path}}` / `{{path:type}}` tokens. Untyped means text. Stray braces are errors. */
export function parsePlaceholders(body: string): ParsedBody {
  const issues: Issue[] = [];
  const seen = new Map<string, PlaceholderType>();
  for (const m of body.matchAll(TOKEN)) {
    const raw = m[1].trim();
    const [path, type = "text", ...extra] = raw.split(":").map((s) => s.trim());
    if (extra.length || !PATH.test(path ?? "")) {
      issues.push({ code: "bad_placeholder", message: `Malformed placeholder {{${raw}}}`, path });
      continue;
    }
    if (!(PLACEHOLDER_TYPES as readonly string[]).includes(type)) {
      issues.push({ code: "bad_type", message: `Unknown type "${type}" for ${path}`, path });
      continue;
    }
    const prev = seen.get(path);
    if (prev && prev !== type) {
      issues.push({ code: "type_conflict", message: `${path} is used as both ${prev} and ${type}`, path });
      continue;
    }
    seen.set(path, type as PlaceholderType);
  }
  const rest = body.replace(TOKEN, "");
  // Full-width and small-form braces count too: they normalise (NFKC) to real ones.
  if (/[{}]/.test(rest) || /[{}]/.test(rest.normalize("NFKC"))) {
    issues.push({ code: "stray_braces", message: "Unbalanced, nested or single braces" });
  }
  return { placeholders: [...seen].map(([path, type]) => ({ path, type })), issues };
}

/** Validates and normalises one value; returns the display string or an error message. */
export function formatValue(type: PlaceholderType, value: unknown): { ok: true; text: string } | { ok: false; message: string } {
  if (type === "int") {
    // A count of days, items or months: a positive whole number. Zero and negatives ("within -30 days") are refused.
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) return { ok: false, message: "expected a positive whole number" };
    return { ok: true, text: String(n) };
  }
  if (type === "money") {
    const s = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof s !== "string" || !/^\d{1,12}(\.\d{1,2})?$/.test(s)) return { ok: false, message: "expected a non-negative amount with at most 2 decimals" };
    const [whole, frac = ""] = s.split(".");
    const grouped = String(BigInt(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return { ok: true, text: `$${grouped}.${frac.padEnd(2, "0")}` };
  }
  if (type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, message: "expected a date as YYYY-MM-DD" };
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return { ok: false, message: "not a real calendar date" };
    return { ok: true, text: value };
  }
  if (typeof value !== "string" && typeof value !== "number") return { ok: false, message: "expected text" };
  if (typeof value === "number" && !(Number.isFinite(value) && PLAIN_NUMBER.test(String(value)))) {
    return { ok: false, message: "a number given as text must be a plain finite number (no NaN, Infinity or exponent)" };
  }
  // A multiline value may arrive with Windows line endings; CRLF becomes LF before any check.
  const s = type === "multiline" ? String(value).replace(/\r\n/g, "\n") : String(value);
  if (!s.trim()) return { ok: false, message: "must not be empty" };
  const max = type === "multiline" ? MAX_MULTILINE : MAX_TEXT;
  if (s.length > max) return { ok: false, message: `longer than ${max} characters` };
  if (type === "multiline" ? NON_LF_BREAK.test(s) : LINE_BREAK.test(s)) {
    return { ok: false, message: type === "multiline" ? "only plain line feeds may break lines" : "must be a single line (declare the placeholder as :multiline to allow line feeds)" };
  }
  if (hasPlaceholderSyntax(s)) return { ok: false, message: "must not contain placeholder syntax {{ or }}" };
  if (LINK.test(s) || LINK.test(s.normalize("NFKC"))) return { ok: false, message: "must not contain a link" };
  const look = lookalikeIssue(s);
  if (look) return { ok: false, message: look };
  return { ok: true, text: s };
}

/** Unknown, missing and wrongly typed parameters. */
export function checkParams(placeholders: Placeholder[], params: Params): { issues: Issue[]; text: Map<string, string> } {
  const issues: Issue[] = [];
  const text = new Map<string, string>();
  const known = new Set(placeholders.map((p) => p.path));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) issues.push({ code: "unknown_param", message: `Unknown parameter ${key}`, path: key });
  }
  for (const p of placeholders) {
    if (!Object.prototype.hasOwnProperty.call(params, p.path)) {
      issues.push({ code: "missing_param", message: `Missing parameter ${p.path}`, path: p.path });
      continue;
    }
    const r = formatValue(p.type, params[p.path]);
    if (!r.ok) issues.push({ code: "bad_param", message: `${p.path}: ${r.message}`, path: p.path });
    else text.set(p.path, r.text);
  }
  return { issues, text };
}
