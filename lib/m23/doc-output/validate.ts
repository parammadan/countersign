import { clauseLabel, type Clause, type DraftDocument } from "./types";

export type DraftErrorCode =
  | "invalid" // wrong shape or type
  | "too_large" // a size limit in LIMITS is exceeded
  | "bidi_control" // a bidi embedding, override, isolate or mark character
  | "invalid_char" // a control or invisible format character, U+FFFE/U+FFFF or a lone surrogate
  | "no_parties"
  | "blank_party"
  | "no_clauses"
  | "no_locked_clause"
  | "duplicate_clause_id"
  | "duplicate_clause_number";

export class DraftValidationError extends Error {
  readonly code: DraftErrorCode;
  constructor(message: string, code: DraftErrorCode = "invalid") {
    super(message);
    this.name = "DraftValidationError";
    this.code = code;
  }
}

// Hard input limits. Anything larger is refused with code "too_large" before any rendering work.
// maxPages is checked while the PDF is laid out (bounded work), so validateDraft alone does not guarantee it.
export const LIMITS = Object.freeze({
  maxParties: 50,
  maxClauses: 2_000,
  maxClauseChars: 200_000, // one clause's text
  maxFieldChars: 1_000, // title, party role/name, clause id/number/heading, origin.versionId
  maxTotalChars: 1_000_000, // all strings together
  maxLineBreaks: 20_000, // all line breaks together
  maxPages: 1_500, // PDF safety net
});

const KINDS = ["generated", "upload", "edit"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Bidi embeddings, overrides, isolates and marks (LRM, RLM, ALM) can make text display in a different order
// from how it is stored (RLM alone reorders "1 2"), so they change what a reader sees: refused.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
// Control characters other than tab, LF, CR, VT and FF; DEL and C1 controls; U+FFFE/U+FFFF; lone surrogates.
// Refused instead of being deleted, because deleting one can join words or digits ("no\u0001t" -> "not").
const BAD = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Every other invisible format character (Unicode Cf: tag characters, invisible operators, digit-shape
// controls, interlinear annotation, ...), except the soft hyphen (printed in both formats) and the
// zero-width characters stripped below.
const FORMAT = /(?![­​-‍⁠﻿])\p{Cf}/u;
// Zero-width characters are invisible in any rendering, so they are stripped (both formats, same way);
// the output then shows exactly what a reader of the source sees. VT, FF and U+2028/U+2029 become line breaks.
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// Blank-looking fillers that String.prototype.trim keeps.
const FILLER = /[\sᅟᅠ⠀ㅤﾠ]/g;

/** Text as both renderers print it: zero-width characters removed, VT/FF/U+2028/U+2029 turned into line breaks. */
export function cleanText(s: string): string {
  return s.replace(ZERO_WIDTH, "").replace(/[\u000B\u000C\u2028\u2029]/g, "\n");
}

/** A single-line field: each line break, with the whitespace around it, becomes one space. Linear time. */
export function oneLine(s: string): string {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length === 1) return s;
  const out = [parts[0].trimEnd()];
  for (let i = 1; i < parts.length - 1; i++) {
    const m = parts[i].trim();
    if (m) out.push(m);
  }
  out.push(parts[parts.length - 1].trimStart());
  return out.join(" ");
}

const isBlank = (s: string) => !cleanText(s).replace(FILLER, "");

/** The character rule validateDraft applies to every string: null when `s` is fine, else the refusal code. */
export function charProblem(s: string): "bidi_control" | "invalid_char" | null {
  if (BIDI.test(s)) return "bidi_control";
  if (BAD.test(s) || FORMAT.test(s)) return "invalid_char";
  return null;
}

function checkChars(s: string, where: string) {
  if (BIDI.test(s)) throw new DraftValidationError(`${where} contains a bidi control character`, "bidi_control");
  if (BAD.test(s) || FORMAT.test(s)) throw new DraftValidationError(`${where} contains a control, format or invalid character`, "invalid_char");
}

function checkLen(s: string, max: number, where: string) {
  if (s.length > max) throw new DraftValidationError(`${where} is longer than ${max} characters`, "too_large");
}

// Key for the duplicate-number check: "1", "1." and "１." are the same number.
const numberKey = (label: string) => label.normalize("NFKC").toLowerCase().replace(/[.\s]+$/, "");

/**
 * Throws DraftValidationError (with a code) unless the draft is renderable and signable. Checks every rule
 * except LIMITS.maxPages, which renderPdf enforces during layout.
 */
export function validateDraft(doc: DraftDocument): void {
  if (!isObj(doc) || doc.schema !== 1) throw new DraftValidationError("unsupported DraftDocument schema");
  if (typeof doc.title !== "string") throw new DraftValidationError("DraftDocument needs a title");
  if (!Array.isArray(doc.parties) || !Array.isArray(doc.clauses)) throw new DraftValidationError("DraftDocument needs parties and clauses arrays");
  if (!isObj(doc.origin) || !KINDS.includes(doc.origin.kind as string)) throw new DraftValidationError("DraftDocument origin.kind must be generated, upload or edit");
  if (doc.origin.versionId !== undefined && typeof doc.origin.versionId !== "string") throw new DraftValidationError("origin.versionId must be a string");
  // Counts first, so an oversized array is refused without walking it.
  if (doc.parties.length > LIMITS.maxParties) throw new DraftValidationError(`more than ${LIMITS.maxParties} parties`, "too_large");
  if (doc.clauses.length > LIMITS.maxClauses) throw new DraftValidationError(`more than ${LIMITS.maxClauses} clauses`, "too_large");
  // Index loops, not forEach: a hole in a sparse array reads as undefined and is refused.
  for (let i = 0; i < doc.parties.length; i++) {
    const p = doc.parties[i];
    if (!isObj(p) || typeof p.role !== "string" || typeof p.name !== "string") throw new DraftValidationError("each party needs a string role and name");
  }
  for (let i = 0; i < doc.clauses.length; i++) {
    const c = doc.clauses[i];
    const at = `clause ${i + 1}`;
    if (!isObj(c)) throw new DraftValidationError(`clause at index ${i} must be an object`);
    if (typeof c.id !== "string") throw new DraftValidationError(`clause at index ${i} needs a string id`);
    if (typeof c.text !== "string") throw new DraftValidationError(`${at} has no text`);
    if (c.heading !== undefined && typeof c.heading !== "string") throw new DraftValidationError(`${at} heading must be a string`);
    if (c.number !== undefined && typeof c.number !== "string") throw new DraftValidationError(`${at} number must be a string`);
    if (c.locked !== undefined && typeof c.locked !== "boolean") throw new DraftValidationError(`${at} locked must be a boolean`);
  }

  // Sizes, before any character scan or rendering.
  const fields: [string, string][] = [["title", doc.title]];
  if (doc.origin.versionId !== undefined) fields.push(["origin.versionId", doc.origin.versionId]);
  doc.parties.forEach((p, i) => fields.push([`party ${i + 1} role`, p.role], [`party ${i + 1} name`, p.name]));
  doc.clauses.forEach((c, i) => {
    fields.push([`clause ${i + 1} id`, c.id]);
    if (c.number !== undefined) fields.push([`clause ${i + 1} number`, c.number]);
    if (c.heading !== undefined) fields.push([`clause ${i + 1} heading`, c.heading]);
  });
  let total = 0;
  for (const [where, s] of fields) {
    checkLen(s, LIMITS.maxFieldChars, where);
    total += s.length;
  }
  doc.clauses.forEach((c, i) => {
    checkLen(c.text, LIMITS.maxClauseChars, `clause ${i + 1} text`);
    total += c.text.length;
  });
  if (total > LIMITS.maxTotalChars) throw new DraftValidationError(`document is longer than ${LIMITS.maxTotalChars} characters`, "too_large");
  doc.clauses.forEach((c, i) => fields.push([`clause ${i + 1} text`, c.text]));
  let breaks = 0;
  for (const [where, s] of fields) {
    checkChars(s, where);
    breaks += (s.match(/\r\n|[\r\n\u000B\u000C\u2028\u2029]/g) ?? []).length;
  }
  if (breaks > LIMITS.maxLineBreaks) throw new DraftValidationError(`document has more than ${LIMITS.maxLineBreaks} line breaks`, "too_large");

  // Content: something signable, with its signature clause and unambiguous clause ids and numbers.
  if (isBlank(doc.title)) throw new DraftValidationError("DraftDocument needs a title");
  if (!doc.parties.length) throw new DraftValidationError("DraftDocument needs at least one party", "no_parties");
  doc.parties.forEach((p, i) => {
    if (isBlank(p.role) || isBlank(p.name)) throw new DraftValidationError(`party ${i + 1} needs a non-blank role and name`, "blank_party");
  });
  if (!doc.clauses.length) throw new DraftValidationError("DraftDocument needs at least one clause", "no_clauses");
  if (!doc.clauses.some((c) => c.locked === true && !isBlank(c.text))) {
    throw new DraftValidationError("DraftDocument needs its locked (signature) clause", "no_locked_clause");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  doc.clauses.forEach((c, i) => {
    if (!c.id.trim()) throw new DraftValidationError(`clause at index ${i} needs a non-blank id`);
    if (ids.has(c.id)) throw new DraftValidationError(`clause ${i + 1} repeats an earlier clause id`, "duplicate_clause_id");
    ids.add(c.id);
    const key = numberKey(clauseLabel(cleanClause(c), i));
    if (labels.has(key)) throw new DraftValidationError(`clause ${i + 1} repeats an earlier clause number`, "duplicate_clause_number");
    labels.add(key);
  });
}

function cleanClause(c: Clause): Clause {
  return {
    ...c,
    text: cleanText(c.text),
    ...(c.heading !== undefined && { heading: oneLine(cleanText(c.heading)) }),
    ...(c.number !== undefined && { number: oneLine(cleanText(c.number)) }),
  };
}

// Plain copy that reads every input property exactly once, so a getter or Proxy cannot show one value to
// validation and another to rendering. Shapes are copied as found; validateDraft rejects bad ones.
function snapshot(doc: unknown): DraftDocument {
  if (!isObj(doc)) return doc as DraftDocument;
  // An array over its count limit is left as is (not walked), so validateDraft refuses it without the copy.
  const copyArr = (a: unknown, max: number, f: (v: unknown) => unknown) => (Array.isArray(a) && a.length <= max ? Array.from(a, f) : a);
  const { schema, title, parties, clauses, origin } = doc;
  return {
    schema,
    title,
    parties: copyArr(parties, LIMITS.maxParties, (p) => (isObj(p) ? { role: p.role, name: p.name } : p)),
    clauses: copyArr(clauses, LIMITS.maxClauses, (c) => {
      if (!isObj(c)) return c;
      const { id, number, heading, text, locked } = c;
      return { id, text, ...(number !== undefined && { number }), ...(heading !== undefined && { heading }), ...(locked !== undefined && { locked }) };
    }),
    origin: isObj(origin) ? (({ kind, versionId }) => ({ kind, ...(versionId !== undefined && { versionId }) }))(origin) : origin,
  } as DraftDocument;
}

/**
 * Validate, then return the copy both renderers print: zero-width characters stripped, VT/FF as line
 * breaks, and line breaks in single-line fields (title, party role and name, clause number and heading)
 * flattened to spaces. The input is read once and never modified.
 */
export function prepareDraft(input: DraftDocument): DraftDocument {
  const doc = snapshot(input);
  validateDraft(doc);
  return {
    ...doc,
    title: oneLine(cleanText(doc.title)),
    parties: doc.parties.map((p) => ({ role: oneLine(cleanText(p.role)), name: oneLine(cleanText(p.name)) })),
    clauses: doc.clauses.map(cleanClause),
  };
}
