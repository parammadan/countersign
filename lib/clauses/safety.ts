import type { Issue } from "./types";

// Tag-like text. Plain comparisons ("a<b ... c>d") are not markup: a generic tag is flagged when it is
// bare (<b>, </b>, <br/>), carries an attribute with a value (<img src=x>, <svg/onload=y>), or is a
// comment/doctype/processing start. Script-capable element names are flagged on their own.
const NAME = "[a-z][a-z0-9:-]*";
const DANGEROUS = "script|style|iframe|object|embed|svg|img|link|meta|form|input|base";
// Boolean attributes that change what is shown or run, and multi-letter HTML element names. Single-letter
// names (a, b, i, p, q, s, u) are left to the rules above so "if a<b and c>d" stays plain text.
const BOOLEAN_ATTRS = "hidden|open|inert|contenteditable|autofocus|popover|draggable|defer|async|nomodule|controls|autoplay|muted|loop|disabled|readonly|required|selected|checked|multiple|novalidate|formnovalidate|allowfullscreen|ismap|itemscope|reversed|default";
const ELEMENTS = "abbr|address|area|article|aside|audio|bdi|bdo|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|fieldset|figcaption|figure|font|footer|frame|frameset|h[1-6]|head|header|hgroup|hr|html|ins|kbd|label|legend|li|main|map|mark|marquee|math|menu|meter|nav|noembed|noscript|ol|optgroup|option|output|picture|plaintext|pre|progress|rp|rt|ruby|samp|search|section|select|slot|small|source|span|strong|sub|summary|sup|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|ul|var|video|wbr|xmp";
const BOOLEAN_RE = new RegExp(`^(?:${BOOLEAN_ATTRS})$`, "i");
// Anchored, quantifier-light checks run on ONE tag candidate at a time (see htmlMarkup).
const BARE_TAG = new RegExp(`^< ?\\/? ?${NAME} ?\\/?>$`, "i");
const VALUED_START = new RegExp(`^<\\/?${NAME}[ \\/]`, "i");
const DANGEROUS_START = new RegExp(`^< ?\\/? ?(?:${DANGEROUS})\\b`, "i");
const CLOSING_START = new RegExp(`^<\\/${NAME}`, "i");
const BOOLEAN_FIRST = new RegExp(`^<${NAME}[ \\/]+(?:${BOOLEAN_ATTRS})(?![^ \\/>=])`, "i");
const NAME_START = new RegExp(`^<${NAME}[ \\/]`, "i");
const ELEMENT_START = new RegExp(`^<(?:${ELEMENTS})[ \\/]`, "i");

/**
 * Tag-like markup, in linear time. The text is cut at every "<" into candidates that run to the next "<" or ">"
 * (disjoint, so the total work is O(n)); whitespace runs are folded to one space; each candidate is tested with
 * anchored patterns without nested quantifiers, and attribute lists are split rather than backtracked over.
 * Same rules as before:
 * - a bare tag (<b>, </b>, <br/>);
 * - a tag with a valued attribute (<img src=x>, <svg/onload=y>);
 * - a script-capable element name, even unclosed;
 * - a comment, doctype or processing instruction;
 * - a closing tag;
 * - a boolean attribute right after the name (<p hidden, <b/hidden);
 * - a boolean attribute among other attributes in a closed tag (<p x1 hidden>);
 * - a known multi-letter element with attributes, closed or running to the end.
 */
function htmlMarkup(text: string): boolean {
  let i = text.indexOf("<");
  while (i !== -1) {
    let j = i + 1;
    while (j < text.length && text[j] !== "<" && text[j] !== ">") j++;
    const closed = j < text.length && text[j] === ">";
    const atEnd = j >= text.length;
    const seg = (text.slice(i, closed ? j + 1 : j)).replace(/\s+/g, " ");
    if (/^<[!?]/.test(seg) || DANGEROUS_START.test(seg) || CLOSING_START.test(seg) || BOOLEAN_FIRST.test(seg)) return true;
    if (closed && (BARE_TAG.test(seg) || (VALUED_START.test(seg) && seg.includes("=")))) return true;
    if (closed && NAME_START.test(seg)) {
      // attributes: split on spaces and "/" (parsers treat "/" between attributes like a space)
      const tokens = seg.slice(1, -1).split(/[ /]+/).slice(1);
      if (tokens.some((t) => BOOLEAN_RE.test(t.split("=")[0]))) return true;
    }
    if ((closed || atEnd) && ELEMENT_START.test(seg)) return true;
    i = text.indexOf("<", i + 1);
  }
  return false;
}

// Markdown links and images: inline `[x](url)` / `![x](url)`, a link definition `[x]: url`, an autolink `<scheme:...>`.
// "[Client Name] (the Client)" is not a link: CommonMark allows no space between `]` and `(`.
// A definition counts inside block quotes and list items too ("> [x]: url", "- [x]: url", "1. [x]: url").
// The label may hold escaped brackets and line breaks, and the destination may sit on the next line, so any
// "[label]:" at the start of a line is refused, even "[Drafting note]: ..." (fail closed).
const MARKDOWN = /!\[|\]\(|^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*\[(?:[^[\]\\]|\\[\s\S])+\]:|<[a-z][a-z0-9+.-]{1,31}:[^\s<>]*>/im;

// Encodings that a renderer may decode into markup, a break or a brace: any numeric character reference (with or
// without its semicolon), the markup-relevant named references even without a semicolon (browsers decode
// "&ltscript"), any other named reference with one, any percent escape (so double encoding %253C is caught by
// its %25), and backslash escapes (<, \u{3c}, \x3c).
const ESCAPE = /&(?:#(?:x[0-9a-f]+|[0-9]+)|lt|gt|amp|quot|apos|[a-z][a-z0-9]{1,31};)|%[0-9a-f]{2}|\\(?:u\{?[0-9a-f]{2,6}|x[0-9a-f]{2})/i;

// Invisible and formatting characters, by Unicode property rather than a list: default-ignorable code points
// (zero-width, word joiner U+2060, Arabic letter mark U+061C, Mongolian vowel separator U+180E, combining
// grapheme joiner U+034F, variation selectors, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, tags), every
// format character (Cf, incl. bidi controls and soft hyphen), private use, unassigned and lone surrogates,
// plus the blank braille pattern U+2800, the half-fill space U+303F and the Khitan filler U+16FE4.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u2800\u303f\u{16fe4}]/u;

// Allow-list: letters, marks, digits, punctuation, symbols, tab, LF, CR, space, no-break space and narrow
// no-break space. Anything else (other controls, exotic spaces, separators) is refused.
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\t\n\r \u00a0\u202f]*$/u;

const LATIN = /\p{Script=Latin}/u;
/**
 * Scripts that may stand next to Latin: Common/Inherited (the micro sign U+00B5) and scripts with no Latin
 * look-alikes (CJK, Hangul, Arabic, Hebrew, Thai, the main Indic scripts), so "LG\uc804\uc790" and "T\u30b7\u30e3\u30c4" pass.
 * Cyrillic, Greek, Armenian, Cherokee, Lisu, Coptic and every other script do not.
 */
export const SAFE_WITH_LATIN = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}]/u;
// Letter forms that imitate plain Latin: mathematical alphanumerics, full-width letters, letterlike symbols
// (Kelvin sign, double-struck C) and letter numbers (Roman numeral D, M ...). Their NFKC form is plain Latin.
// Ordinal indicators, the micro sign, ligatures and the litre sign U+2113 are ordinary text and stay allowed.
export const LATIN_FORM = /(?!\u2113)[\u{1d400}-\u{1d7ff}\uff21-\uff3a\uff41-\uff5a\u2100-\u214f\p{Nl}]/u;

/** One word mixing Latin with a look-alike script ("Maple" with a Cyrillic U+0430), or using imitation letter forms. */
function mixedScriptWord(text: string): boolean {
  for (const [w] of text.matchAll(/[\p{L}\p{M}\p{Nl}]+/gu)) {
    if (LATIN_FORM.test(w)) return true;
    if (LATIN.test(w) && [...w].some((c) => /\p{L}/u.test(c) && !SAFE_WITH_LATIN.test(c))) return true;
  }
  return false;
}

const MARKERS: Array<[string, { test(t: string): boolean }, string]> = [
  ["unsafe_html", { test: htmlMarkup }, "markup or HTML tag"],
  ["unsafe_markdown", MARKDOWN, "a markdown link or image"],
  // data: only with a real media type or a bare ;/, (data:,x  data:;base64), so "personal data: name/address" is plain text.
  ["unsafe_script_url", /\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*(?:(?:text|image|application|audio|video|font|model|multipart|message)\/[a-z0-9.+-]+\s*[;,]|;|,)/i, "script or data URL"],
  ["unsafe_template", /\$\{|<%|%>|\{%|%\}|\{#|#\}/, "other template syntax"],
  ["unsafe_control", /(?![\t\n\r])\p{Cc}|[\u2028\u2029]/u, "control character"],
  ["unsafe_bidi", INVISIBLE, "invisible or bidirectional text control"],
  // Five or more stacked marks, or any overlay mark (strike-through U+0334-U+0338, enclosing/overlay U+20D2-U+20EA):
  // "s\u0336h\u0336a\u0336l\u0336l\u0336" displays a struck-through "shall".
  ["unsafe_marks", /\p{M}{5,}|\p{Me}|[\u0334-\u0338\u20d2\u20d3\u20d8-\u20da\u20dd-\u20e0\u20e2-\u20e4\u20e5\u20e6\u20ea\u20eb]/u, "a stack of combining marks or an overlay mark"],
  ["unsafe_escape", ESCAPE, "encoded markup, line break or brace"],
];

/** Deterministic scan for content that must never enter a clause body, a rendered value or a rendered result. */
export function unsafeMarkers(text: string): Issue[] {
  const out: Issue[] = [];
  // Compatibility normalisation first, so full-width look-alikes (U+FF1C etc.) are seen as what they imitate.
  const forms = new Set([text, text.normalize("NFKC")]);
  for (const [code, re, what] of MARKERS) {
    for (const t of forms) {
      if (re.test(t)) { out.push({ code, message: `Contains ${what}` }); break; }
    }
  }
  const known = new Set(out.map((i) => i.code));
  if (!known.has("unsafe_control") && !known.has("unsafe_bidi") && ![...forms].every((t) => ALLOWED.test(t))) {
    out.push({ code: "unsafe_char", message: "Contains a character outside letters, digits, punctuation, symbols and plain spaces" });
  }
  // Raw text only: NFKC turns the micro sign (Common) into Greek mu, which would flag "5 micrometres" written with U+00B5.
  if (mixedScriptWord(text)) out.push({ code: "unsafe_mixed_script", message: "Contains a word mixing Latin with look-alike letters" });
  return out;
}
