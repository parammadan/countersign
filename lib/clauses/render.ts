import { checkParams, hasPlaceholderSyntax, parsePlaceholders } from "./placeholders";
import { unsafeMarkers } from "./safety";
import { ClauseError, type ClauseVersion, type Issue, type Params, type Placeholder } from "./types";

const MAX_BODY = 20_000;

export interface Validation { ok: boolean; issues: Issue[]; placeholders: Placeholder[] }

/** Validates a clause body (syntax, types, unsafe markers). Pure and deterministic. */
export function validateBody(body: string): Validation {
  const issues: Issue[] = [];
  if (typeof body !== "string" || !body.trim()) issues.push({ code: "empty_body", message: "Body is empty" });
  else if (body.length > MAX_BODY) issues.push({ code: "body_too_long", message: `Body is longer than ${MAX_BODY} characters` });
  const text = typeof body === "string" ? body : "";
  const parsed = parsePlaceholders(text);
  // Scan with each placeholder stood in by a letter and by a digit, so markers cannot be assembled
  // from a fixed prefix plus a parameter (`<{{a}}`, `&#{{n:int}};`, `${{a}}`).
  const seen = new Set<string>();
  for (const filler of ["a", "0"]) {
    for (const i of unsafeMarkers(text.replace(/\{\{[^{}]*\}\}/g, filler))) {
      if (!seen.has(i.code)) { seen.add(i.code); issues.push(i); }
    }
  }
  if (/[<&$%]\{\{|&#x?\{\{/i.test(text)) {
    issues.push({ code: "unsafe_adjacent", message: "A placeholder may not sit directly against <, &, $ or %, or inside &#" });
  }
  issues.push(...parsed.issues);
  return { ok: issues.length === 0, issues, placeholders: parsed.placeholders };
}

/**
 * Deterministic render: a single pass, values are never re-scanned for placeholders. Values may not carry
 * placeholder syntax, and the result is checked again so two adjacent values (`x{` + `{y}}`) cannot form one.
 */
export function renderBody(body: string, placeholders: Placeholder[], params: Params): string {
  // The body decides the placeholder types, never the caller: a list that disagrees with the body is refused, so
  // nobody can, for example, turn a plain `{{a}}` into a multiline value by passing a different list.
  const parsed = parsePlaceholders(typeof body === "string" ? body : "");
  const sig = (ps: Placeholder[]) => ps.map((p) => `${p.path}:${p.type}`).sort().join("|");
  if (parsed.issues.length || !Array.isArray(placeholders) || sig(parsed.placeholders) !== sig(placeholders)) {
    throw new ClauseError("invalid_body", "Placeholder list does not match the clause body", parsed.issues);
  }
  const { issues, text } = checkParams(placeholders, params);
  for (const v of text.values()) issues.push(...unsafeMarkers(v).map((i) => ({ ...i, message: `Parameter value: ${i.message}` })));
  if (issues.length) throw new ClauseError("invalid_params", issues.map((i) => i.message).join("; "), issues);
  const out = body.replace(/\{\{([^{}]*)\}\}/g, (_m, raw: string) => {
    const v = text.get(raw.split(":")[0].trim());
    if (v === undefined) throw new ClauseError("invalid_params", `No value for {{${raw}}}`);
    return v;
  });
  const bad = unsafeMarkers(out);
  if (hasPlaceholderSyntax(out)) bad.push({ code: "placeholder_syntax", message: "Contains placeholder syntax {{ or }}" });
  if (bad.length) throw new ClauseError("invalid_params", `Rendered text: ${bad.map((i) => i.message).join("; ")}`, bad);
  return out;
}

/** Renders any version for preview; use `useInDraft` in the service for the approved-only gate. */
export function renderVersion(v: ClauseVersion, params: Params): string {
  return renderBody(v.body, v.placeholders, params);
}
