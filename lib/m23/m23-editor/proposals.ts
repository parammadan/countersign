import type { Clause, DraftDocument, EditProposal } from "./types";
import { charProblem } from "../doc-output/validate";

export type ApplyResult =
  | { ok: true; doc: DraftDocument }
  | { ok: false; status: "conflict" | "blocked"; reason: string };

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let c = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) c++;
  return c;
}

const conflict = (reason: string): ApplyResult => ({ ok: false, status: "conflict", reason });

// Cross-references: "clause 4", "Clause 4.2", "CLAUSES 3 and 4", "clauses 2, 3, and 4", "clauses 3 & 4",
// "clauses 3 and/or 4", "clauses 3 to 5", "clauses 3-5". After a singular "clause" a list continues through
// "and"/"or"/"to"/"-" ("clause 3 or 4") but a bare comma ends it ("under clause 3, 2 copies" refers to clause 3 only).
const NUM = String.raw`\d+(?:\.\d+)*`;
const LIST_SEP = String.raw`(?:\s*,\s*(?:and|or)\s+|\s+and\/or\s+|\s*,\s*|\s+(?:and|or|to|through)\s+|\s*[-–&]\s*)`;
const REF = new RegExp(String.raw`\b(clauses?)(\s+)(${NUM}(?:${LIST_SEP}${NUM})*)`, "giu");
const REF_PART = new RegExp(String.raw`(\d+)((?:\.\d+)*)|(${LIST_SEP})`, "giu");
const RANGE = new Set(["to", "through", "-", "–"]);
/** `.` or `;` ending a sentence or clause: followed by the end, or by a space (after ".", not a lower-case word: "5. days"). */
function plainBoundary(after: string): boolean {
  return /^[.;]\s*$/.test(after) || /^;\s/.test(after) || /^\.\s+(?![\p{Ll}])/u.test(after);
}

/**
 * Strict rule: a list's later number is only taken as a clause when what follows it closes the reference:
 * - the end of the text, or `.`/`;` as in `plainBoundary`;
 * - `)` or `]` closing a bracket opened earlier in the same sentence, before the reference ("(see clauses 6 and
 *   7)."), then the end or a `plainBoundary`; a `.` or `;` may come just before it ("(see clauses 6 and 7.)");
 * - `,` followed by another clause reference ("clauses 3 and 4, clause 4.2"), unless the number came after a bare
 *   comma ("clauses 2 and 3, 5, if present").
 * Anything else ("3 copies", "5%", "5 May 2028", ", the Client", "5) days", "(clause 3 and 5) days", "5... 4 copies")
 * may make it a quantity, so the edit conflicts. A word list of reference verbs was tried and bypassed in three
 * review rounds, and allowing any comma let "5, being days" through, so neither is used.
 */
function endsReference(after: string, afterBareComma: boolean, bracketOpen: boolean): boolean {
  if (/^\s*$/.test(after) || plainBoundary(after)) return true;
  const close = bracketOpen ? /^[.;]?[)\]]/.exec(after) : null;
  if (close) {
    const rem = after.slice(close[0].length);
    // ".)" already ends the sentence, so a space may follow; a bare ")" needs its own boundary
    return /^\s*$/.test(rem) || (close[0].length === 2 ? /^\s/.test(rem) : plainBoundary(rem));
  }
  return !afterBareComma && /^,\s+clauses?\b/i.test(after);
}

/** True when the current sentence of `before` has a `(` or `[` that is still open (the reference sits inside it). */
function insideBrackets(before: string): boolean {
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf("\n"));
  let depth = 0;
  for (const ch of before.slice(cut + 1)) {
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
  }
  return depth > 0;
}

/**
 * What comes before "clause" must show a cross-reference: the start of the text, a space after `.`, `;`, `:`, `,`, `(`,
 * `[` or a line break, or one of these words then a space. Anything else ("this clause 2 copies", "its clause 3 days",
 * "this entire clause 2", "sub-clause 2", "Schedule clause 2") may make the number something other than a top-level
 * clause, so changing it is a conflict. An allow-list, so an unknown word fails closed.
 */
const INTRODUCERS = new Set([
  "in", "under", "to", "see", "of", "by", "with", "per", "and", "or", "from", "than", "at", "on", "into", "within",
  "then", "read", "between", "including", "excluding", "except", "notwithstanding", "following", "nor", "but", "also",
  "follow", "follows", "as", "if", "unless", "after", "before", "during", "breach", "breaches", "amend", "amends",
]);
/**
 * `before` is a bounded window of the text just before "clause" (see REF_WINDOW); `atTextStart` says whether that
 * window begins at the start of the text. A window that may start mid-word or mid-marker is read fail-closed.
 */
function introducesReference(before: string, atTextStart: boolean): boolean {
  if (/[.;:,([\n]\s*$/.test(before)) return true;
  if (atTextStart && /^\s*$/.test(before)) return true;
  const marker = /(^|\s)\((?:[a-z]|[ivx]+|\d+)\)\s+$/i.exec(before); // list marker: "(a) clause 3 applies"
  if (marker && (marker[1] !== "" || atTextStart)) return true;
  const w = /(^|[^\p{L}\p{N}-])(\p{L}+) +$/u.exec(before);
  if (!w || (w[1] === "" && !atTextStart)) return false; // the word may be cut off at the window's start
  return INTRODUCERS.has(w[2].toLowerCase());
}

/** How much text around each reference is read. Bounded, so renumbering is linear in the text length. */
const REF_WINDOW = 240;

const partyNames = (d: DraftDocument): string[] => (Array.isArray(d.parties) ? d.parties.map((x) => (typeof x?.name === "string" ? x.name : "")) : []);
const partyRoles = (d: DraftDocument): string[] => (Array.isArray(d.parties) ? d.parties.map((x) => (typeof x?.role === "string" ? x.role : "")) : []);

/**
 * A party name containing "Clause N" ("Clause 7 Studios LLC"): if renumbering would change or delete clause N, the edit
 * conflicts. Rewriting the name would rename the party, and leaving every "clause N" alone could leave a real
 * reference pointing at the wrong clause, so neither is done silently.
 */
function partyNameConflict(r: Renumbering): string | null {
  for (const nm of r.names) {
    for (const m of nm.matchAll(/\bclauses?\s+(\d+)/giu)) {
      if (r.gone.has(m[1]) || (r.map.get(m[1]) ?? m[1]) !== m[1])
        return `the party name ${JSON.stringify(nm)} contains "${m[0]}", which this edit would renumber; rename the clauses by hand or regenerate the draft`;
    }
  }
  return null;
}

/**
 * "clause 4 of the Master Agreement", "clause 2 in Schedule 3": a reference into another document. Its number must not
 * follow this document's renumbering, and leaving it could equally be wrong, so a change is a conflict. "of this
 * Agreement", "of the Agreement" and "hereof" stay this document.
 */
const DOC_NOUN = /^(?:agreements?|schedules?|annex(?:es)?|annexures?|appendix|appendices|exhibits?|contracts?|leases?|orders?|order forms?|statements? of work|sow|msa|terms|policy|policies|deeds?|licen[cs]es?|addend(?:um|a)|amendments?|riders?|handbooks?|manuals?|guidelines?|specifications?|specs?|rate\s+cards?|codes?|plans?|charters?|frameworks?|acts?|regulations?|rules|standards?|protocols?)\b/i;
function otherDocument(after: string, roles: readonly string[]): boolean {
  if (/^\s+thereof\b/i.test(after)) return true;
  const m = /^\s+(?:of|in|under|to)\s+/i.exec(after);
  if (!m) return false;
  const tail = after.slice(m[0].length);
  // this document
  if (/^(?:this|the)\s+agreement\b/i.test(tail) && !/^the\s+agreement\s+(?:dated|between|of|made|entered|signed|executed)\b/i.test(tail)) return false;
  // the window: up to 4 words, ending at the first sentence end ("to the Provider. This Agreement binds" stops at ".")
  const words: string[] = [];
  for (const w of tail.split(/\s+/).slice(0, 4)) {
    words.push(w);
    if (/[.;]$/.test(w)) break; // not ":", which introduces what it refers to ("of the following: the Master Agreement")
  }
  // a document noun anywhere in the window is another document, even after a party ("the Client's standard terms")
  for (let i = 0; i < words.length; i++) if (DOC_NOUN.test(words.slice(i).join(" "))) return true;
  // a party as the whole phrase ("payable under clause 4 to the Provider", "... to the Client in writing"): the role,
  // then the end, punctuation or a lower-case word that is not a possessive
  const afterDet = tail.replace(/^(?:the|this|that|each|any)\s+/i, "");
  for (const r of roles) {
    if (!r) continue;
    const head = afterDet.slice(0, r.length);
    const next = afterDet.slice(r.length);
    if (head.toLowerCase() === r.toLowerCase() && (/^\s*$/.test(next) || /^[.,;:)\]]/.test(next) || /^\s+\p{Ll}/u.test(next))) return false;
  }
  // up to three words, then a capitalised name (determiners skipped)
  for (let i = 0; i < words.length; i++) {
    if (DOC_NOUN.test(words.slice(i).join(" "))) return true;
    const w = words[i].replace(/[.,;:)\]]+$/, "");
    if (/^\p{Lu}/u.test(w) && !/^(?:this|the|that|each|any|a|an|our|its|their|such)$/i.test(w)) return true;
    if (/[.;]$/.test(words[i])) break; // the phrase ends at a sentence or clause end
  }
  return false;
}

type Mapped = { ok: true; text: string } | { ok: false; reason: string };
/** Numbering facts for `mapRefs`: old -> new numbers, deleted numbers, numbers that existed, and the new highest. */
type Renumbering = { map: Map<string, string>; gone: Set<string>; known: Set<string>; limit: number; names: readonly string[]; roles: readonly string[] };

/**
 * Rewrite clause references in `text` through `r.map`. Refused (fail closed): a reference to a deleted clause, a
 * range whose meaning would change ("clauses 3 to 5" with a clause added or removed inside it), and a reference to a
 * clause that did not exist but would now ("clause 6" in a 5-clause draft that gains a sixth clause). Other numbers
 * (e.g. "clause 99") are left as written.
 */
// Words that mark a cross-reference in any form, including forms the rewriter does not handle ("Section 8", "cl. 8",
// "paragraph 8", "clause no. 8", "clauses (8) and (9)").
const REF_WORD = /\b(?:clauses?|sections?|cl\.|paragraphs?|paras?\.?|articles?|sub-?clauses?)(?![\p{L}])/iu;
// Invisible characters that can split a reference without the reader seeing it ("clauses 8\u200b and 9").
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/u;
// A bare whole number (not part of a decimal, a grouped figure, a currency amount or a percentage).
const BARE_NUMBER = /(?<![\d.,$€£¥₹])\b(\d{1,4})\b(?![.,]\d|\s*%)/gu;

/** Sentences of `text` with their start offsets (split at ". X", "; " and line breaks). */
function sentences(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s+[\p{Lu}(])|;|\n/gu)) {
    const end = m.index! + m[0].length;
    out.push({ start, text: text.slice(start, end) });
    start = end;
  }
  out.push({ start, text: text.slice(start) });
  return out;
}

function mapRefs(text: string, r: Renumbering, where: string): Mapped {
  let failure: string | null = null;
  const shifted = [...r.map].some(([o, nw]) => o !== nw);
  const consumed = new Set<number>(); // offsets of numbers the rewriter handles
  const out = text.replace(REF, (all: string, word: string, sp: string, list: string, offset: number, string: string) => {
    let parts = [...list.matchAll(REF_PART)];
    const listStart = offset + word.length + sp.length;
    let tail = "";
    if (word.toLowerCase() === "clause") {
      // "clause 3 or 4", "clause 3 and 4", "clause 3-4" are lists too; a bare comma ends the reference
      // ("under clause 3, 2 copies").
      const cut = parts.findIndex((m) => m[3] !== undefined && m[3].trim() === ",");
      if (cut >= 0) {
        tail = list.slice(parts[cut].index);
        parts = parts.slice(0, cut);
      }
    }
    for (const m of parts) {
      if (m[1] === undefined) continue;
      if (r.gone.has(m[1])) failure ??= `${where} refers to clause ${m[1]}, which is being deleted`;
      else if (!r.known.has(m[1]) && Number(m[1]) <= r.limit) failure ??= `${where} refers to clause ${m[1]}, which did not exist when it was written`;
    }
    for (let i = 0; i + 2 < parts.length; i++) {
      const [a, sep, b] = [parts[i], parts[i + 1], parts[i + 2]];
      if (a[1] === undefined || sep[3] === undefined || b[1] === undefined || !RANGE.has(sep[3].trim().toLowerCase())) continue;
      const lo = Number(a[1]), hi = Number(b[1]);
      let intact = hi >= lo && r.map.has(a[1]) && r.map.has(b[1]) && Number(r.map.get(b[1])) - Number(r.map.get(a[1])) === hi - lo;
      for (let k = lo; intact && k <= hi; k++) if (!r.map.has(String(k))) intact = false;
      if (!intact && shifted) failure ??= `${where} refers to the range "${all}", whose meaning would change`;
    }
    // A list's later numbers can be quantities, not clauses ("clauses 6 and 7, 3 copies", "clause 7 and 5 days").
    // When renumbering would change such a number, refuse instead of guessing: a last number not followed by end or
    // closing punctuation (see endsReference), or a later number below the one before it.
    const nums = parts.filter((m) => m[1] !== undefined);
    // The window after the reference. When it stops short of the real end of the text, a sentinel takes the place of
    // the rest, so "end of text" checks can't pass on a cut-off window ("clauses 3 and 4<300 spaces>copies").
    const afterEnd = offset + all.length + REF_WINDOW;
    const cutShort = afterEnd < string.length;
    // when cut short, the last word may be cut in half: drop it, so only complete words are read
    const raw = string.slice(offset + all.length, afterEnd);
    const after = cutShort ? raw.replace(/\S+$/u, "") + "\u0000" : raw;
    const rest = list + after;
    const changes = (m: RegExpMatchArray) => (r.map.get(m[1]) ?? m[1]) !== m[1];
    const from = Math.max(0, offset - REF_WINDOW);
    const before = string.slice(from, offset);
    if (!introducesReference(before, from === 0) && nums.some(changes))
      failure ??= `${where} has "${(/\S*\s*$/.exec(before)?.[0] ?? "").trim()} ${all.trim()}", where the number may not be a clause number (a quantity, a sub-clause or another document's clause); write the reference as "under clause N" or "see clause N"`;
    const bracketOpen = insideBrackets(before);
    // a cut-off window with fewer than 5 words can't show what document the reference names: treat it as another one
    const tooShortToTell = cutShort && (after.match(/[^\s\u0000]+/g)?.length ?? 0) < 5;
    if (!tail && nums.some(changes) && (tooShortToTell || otherDocument(after, r.roles)))
      failure ??= `${where} has "${all.trim()}" followed by another document's name, so it may not be a clause of this agreement; check it and renumber it by hand`;
    for (let i = 1; i < nums.length; i++) {
      const m = nums[i];
      if (!changes(m)) continue;
      const sepBefore = parts[parts.indexOf(m) - 1]?.[3]?.trim();
      const wordAfter = i === nums.length - 1 && !endsReference(rest.slice(m.index! + m[0].length), sepBefore === ",", bracketOpen);
      const descending = !m[2] && !nums[i - 1][2] && Number(m[1]) < Number(nums[i - 1][1]);
      if (wordAfter || descending)
        failure ??= `${where} has "${all.trim()}", where ${m[1]} may be a quantity rather than a clause; write each reference as "clause N"`;
    }
    for (const m of parts) if (m[1] !== undefined) consumed.add(listStart + m.index!);
    const rewritten = parts.map((m) => (m[1] !== undefined ? (r.map.get(m[1]) ?? m[1]) + m[2] : m[0])).join("");
    return `${word}${sp}${rewritten}${tail}`;
  });
  if (!failure && shifted) {
    // Fail closed on anything the rewriter cannot see: an invisible character in a text that is being renumbered,
    // and any clause number that would change appearing in a sentence with a reference word but outside a reference
    // the rewriter handled ("clauses 8 and also 9", "clause 8, 9 and 10", "Section 8", "cl. 8", "clauses (8) and (9)").
    if (INVISIBLE.test(text)) failure = `${where} contains invisible characters, so its references cannot be renumbered safely; remove them first`;
    for (const sen of failure ? [] : sentences(text)) {
      if (!REF_WORD.test(sen.text)) continue;
      for (const m of sen.text.matchAll(BARE_NUMBER)) {
        const at = sen.start + m.index!;
        if (consumed.has(at)) continue;
        const n = m[1];
        if (r.gone.has(n) || (r.known.has(n) && (r.map.get(n) ?? n) !== n)) {
          failure = `${where} mentions ${n} next to a reference ("${sen.text.trim().slice(0, 80)}") in a form that cannot be renumbered safely; write each reference as "clause N"`;
          break;
        }
      }
      if (failure) break;
    }
  }
  return failure ? { ok: false, reason: failure } : { ok: true, text: out };
}

const isSequential = (cs: Clause[]) => {
  const numbered = cs.filter((c) => c.number !== undefined);
  return numbered.length > 0 && numbered.every((c, i) => c.number === String(i + 1));
};

/**
 * Clause numbering after a structural edit (add_clause, or a delete that removes a whole clause), matching S1's scheme:
 * numbered clauses are "1".."N" in document order, locked ones included.
 * - No clause numbered: nothing changes (the renderer numbers by position).
 * - Numbered "1".."K" in order (clauses without a number, e.g. an unnumbered signature block, are skipped and stay
 *   unnumbered): every clause that had a number, and every new clause, is renumbered 1..K' in order, and clause
 *   references in any clause TEXT (headings are not touched), locked clauses included, are rewritten to the new numbers
 *   (S1 resolves its cross-references to "clause N"). A reference to a deleted clause, or a range whose meaning would
 *   change, is a conflict.
 * - Any other scheme ("1.1", "A", gaps): adding a clause is a conflict, because its number cannot be inferred and a
 *   positional number could repeat an existing one; deleting leaves the other numbers as they are.
 * Known limits: any "clause N" in text is taken to mean this document, so "clause 4 of the Master Agreement" is
 * rewritten too, and prose such as "this clause 2 weeks" can be misread.
 */
function renumber(before: Clause[], after: Clause[], adding: boolean, names: readonly string[], roles: readonly string[]): { ok: true; clauses: Clause[] } | { ok: false; reason: string } {
  if (!before.some((c) => c.number !== undefined)) return { ok: true, clauses: after };
  if (!isSequential(before)) {
    return adding ? { ok: false, reason: "clause numbers are not 1..N in order, so a new clause cannot be numbered" } : { ok: true, clauses: after };
  }
  const old = new Map(before.map((c) => [c.id, c]));
  const map = new Map<string, string>();
  let n = 0;
  const renumbered = after.map((c) => {
    const prev = old.get(c.id);
    if (prev && prev.number === undefined) return c;
    const number = String(++n);
    if (prev?.number !== undefined) map.set(prev.number, number);
    return { ...c, number };
  });
  const gone = new Set(before.map((c) => c.number).filter((x): x is string => x !== undefined && !map.has(x)));
  const known = new Set(before.map((c) => c.number).filter((x): x is string => x !== undefined));
  const facts: Renumbering = { map, gone, known, limit: n, names, roles };
  const named = partyNameConflict(facts);
  if (named) return { ok: false, reason: named };
  const clauses: Clause[] = [];
  for (const c of renumbered) {
    const was = old.get(c.id)?.number;
    const where = `${c.locked ? "locked " : ""}clause ${was ?? c.id}`;
    const r = mapRefs(c.text, facts, where);
    if (!r.ok) return { ok: false, reason: `${r.reason}; ${c.locked ? "regenerate the draft or reject this edit" : "change that reference first"}` };
    clauses.push(r.text === c.text ? c : { ...c, text: r.text });
  }
  return { ok: true, clauses };
}

/**
 * Proposals are written against the editor's base document, so a clause number in a proposal's `before`/`after` means
 * the base numbering. Translate it to the numbering of `doc` (after earlier adds/deletes), so accepting proposals in
 * any order, or undoing one, keeps every reference pointing at the clause it was written for.
 */
function inBaseNumbering(base: DraftDocument, doc: DraftDocument, p: EditProposal): { ok: true; p: EditProposal } | { ok: false; reason: string } {
  if (base === doc || !isSequential(base.clauses)) return { ok: true, p };
  const now = new Map(doc.clauses.map((c) => [c.id, c.number]));
  const map = new Map<string, string>();
  const gone = new Set<string>();
  const known = new Set<string>();
  for (const c of base.clauses) {
    if (c.number === undefined) continue;
    known.add(c.number);
    const cur = now.get(c.id);
    if (cur === undefined) gone.add(c.number); else map.set(c.number, cur);
  }
  const facts: Renumbering = { map, gone, known, limit: doc.clauses.filter((c) => c.number !== undefined).length, names: partyNames(doc), roles: partyRoles(doc) };
  const named = partyNameConflict(facts);
  if (named) return { ok: false, reason: named };
  const b = mapRefs(p.before, facts, "the proposal");
  const a = mapRefs(p.after, facts, "the proposal");
  if (!b.ok) return b;
  if (!a.ok) return a;
  return { ok: true, p: { ...p, before: b.text, after: a.text } };
}

/** A trailing locked signature or execution block (S1's "signatures", an upload's "Execution"). Nothing goes after it. */
const isExecutionBlock = (c: Clause | undefined) =>
  c?.locked === true && /\b(?:signatures?|execution|executed|signed|witness(?:es)?)\b/i.test(`${c.id} ${c.heading ?? ""}`);

/**
 * Apply one proposal to a document without mutating it. `before` must match exactly once, else conflict.
 * `base` is the document the proposal was written against (the editor's base); clause numbers in its text are read in
 * that numbering. It defaults to `doc`.
 */
export function applyProposal(doc: DraftDocument, proposal: EditProposal, base: DraftDocument = doc): ApplyResult {
  const translated = inBaseNumbering(base, doc, proposal);
  if (!translated.ok) return conflict(translated.reason);
  const p = translated.p;
  const idx = doc.clauses.findIndex((c) => c.id === p.clauseId);
  const withClauses = (clauses: Clause[]): ApplyResult => ({
    ok: true,
    doc: { ...doc, clauses, origin: { kind: "edit", versionId: doc.origin.versionId } },
  });
  /** A change to which clauses exist: renumber (see `renumber`) before returning. */
  const restructured = (clauses: Clause[], adding: boolean): ApplyResult => {
    const r = renumber(doc.clauses, clauses, adding, partyNames(doc), partyRoles(doc));
    return r.ok ? withClauses(r.clauses) : conflict(r.reason);
  };

  if (p.op === "delete" && p.after !== "") return conflict("delete requires an empty `after`");
  if (INVISIBLE.test(p.after)) return conflict("the new text contains invisible characters (zero-width, word joiner or soft hyphen); remove them");
  const bad = charProblem(p.after);
  if (bad) return conflict(`the new text contains a ${bad === "bidi_control" ? "bidi control" : "control, format or invalid"} character, which the renderer refuses`);

  if (p.op === "add_clause") {
    if (p.before !== "") return conflict("add_clause requires an empty `before`");
    if (!p.after.trim()) return conflict("add_clause requires text");
    if (doc.clauses.some((c) => c.id === `new:${p.id}`)) return conflict("clause already added");
    const fresh: Clause = { id: `new:${p.id}`, text: p.after };
    if (p.clauseId === "") {
      // "At the end" means before a trailing locked signature block (S1 ends every draft with one), never after it.
      const last = doc.clauses[doc.clauses.length - 1];
      const sig = isExecutionBlock(last);
      return restructured(sig ? [...doc.clauses.slice(0, -1), fresh, last] : [...doc.clauses, fresh], true);
    }
    if (idx < 0) return conflict(`clause ${p.clauseId} not found`);
    const target = doc.clauses[idx];
    if (idx === doc.clauses.length - 1 && isExecutionBlock(target))
      return conflict("a clause cannot be added after the signature clause; add it at the end instead");
    return restructured([...doc.clauses.slice(0, idx + 1), fresh, ...doc.clauses.slice(idx + 1)], true);
  }

  if (idx < 0) return conflict(`clause ${p.clauseId} not found`);
  const clause = doc.clauses[idx];
  if (clause.locked) return { ok: false, status: "blocked", reason: `clause ${clause.id} is locked` };
  const n = countOccurrences(clause.text, p.before);
  if (n === 0) return conflict("`before` text not found in clause");
  if (n > 1) return conflict("`before` text matches more than once");
  const at = clause.text.indexOf(p.before);
  const end = at + p.before.length;

  if (p.op === "delete" && p.before === clause.text)
    return restructured(doc.clauses.filter((_, i) => i !== idx), false);
  let text: string;
  if (p.op === "replace") text = clause.text.slice(0, at) + p.after + clause.text.slice(end);
  else if (p.op === "insert_after") text = clause.text.slice(0, end) + p.after + clause.text.slice(end);
  else text = clause.text.slice(0, at) + clause.text.slice(end);
  return withClauses(doc.clauses.map((c, i) => (i === idx ? { ...c, text } : c)));
}

/** Editor session: the doc is always `base` plus the accepted proposals replayed in acceptance order. */
export type EditorState = {
  base: DraftDocument;
  proposals: EditProposal[];
  accepted: string[];
  doc: DraftDocument;
  errors: Record<string, string>;
};

export function createEditor(base: DraftDocument, proposals: EditProposal[]): EditorState {
  if (new Set(proposals.map((p) => p.id)).size !== proposals.length) throw new Error("duplicate proposal ids");
  // Rehydration: proposals already marked accepted are replayed (in list order) so the doc matches their status.
  const accepted = proposals.filter((p) => p.status === "accepted").map((p) => p.id);
  const state = replay({ base, proposals: proposals.map((p) => ({ ...p })), accepted, doc: base, errors: {} });
  // Rehydrated conflict/blocked proposals get an explanation again (re-checked against the replayed doc; status is kept).
  const errors = { ...state.errors };
  for (const p of state.proposals) {
    if ((p.status === "conflict" || p.status === "blocked") && !(p.id in errors)) {
      const r = applyProposal(state.doc, p, base);
      errors[p.id] = r.ok ? (p.status === "blocked" ? "no longer blocked; reject or re-check" : "no longer conflicts; accept to retry") : r.reason;
    }
  }
  return { ...state, errors };
}

function replay(s: EditorState): EditorState {
  let doc = s.base;
  const accepted: string[] = [];
  const errors: Record<string, string> = {};
  const proposals = s.proposals.map((p) => ({ ...p }));
  for (const id of s.accepted) {
    const p = proposals.find((q) => q.id === id)!;
    const r = applyProposal(doc, p, s.base);
    if (r.ok) { doc = r.doc; accepted.push(id); p.status = "accepted"; }
    else { p.status = r.status; errors[id] = r.reason; }
  }
  // Keep errors of other open (conflict/blocked) proposals that are not part of the replay.
  for (const [id, reason] of Object.entries(s.errors)) {
    const q = proposals.find((x) => x.id === id);
    if (q && (q.status === "conflict" || q.status === "blocked") && !(id in errors)) errors[id] = reason;
  }
  return { base: s.base, proposals, accepted, doc, errors };
}

const find = (s: EditorState, id: string) => s.proposals.find((p) => p.id === id);

/** Accept a proposed (or conflicted, to retry) proposal. A failed apply marks it conflict/blocked and leaves the doc unchanged. */
export function acceptProposal(s: EditorState, id: string): EditorState {
  const p = find(s, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== "proposed" && p.status !== "conflict") throw new Error(`cannot accept a ${p.status} proposal`);
  const r = applyProposal(s.doc, p, s.base);
  const proposals = s.proposals.map((q) => (q.id === id ? { ...q, status: r.ok ? ("accepted" as const) : r.status } : q));
  if (!r.ok) return { ...s, proposals, errors: { ...s.errors, [id]: r.reason } };
  const errors = { ...s.errors };
  delete errors[id];
  return { ...s, proposals, accepted: [...s.accepted, id], doc: r.doc, errors };
}

export function rejectProposal(s: EditorState, id: string): EditorState {
  const p = find(s, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  // A blocked proposal (locked clause) can be rejected so it stops holding up publishing.
  if (p.status === "accepted" || p.status === "rejected") throw new Error(`cannot reject a ${p.status} proposal`);
  const errors = { ...s.errors };
  delete errors[id];
  return { ...s, proposals: s.proposals.map((q) => (q.id === id ? { ...q, status: "rejected" as const } : q)), errors };
}

/** Undo an accepted or rejected proposal back to `proposed`. Later accepted proposals are replayed; any that no longer apply become conflicts. */
export function undoProposal(s: EditorState, id: string): EditorState {
  const p = find(s, id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== "accepted" && p.status !== "rejected") throw new Error(`nothing to undo for a ${p.status} proposal`);
  const next: EditorState = {
    ...s,
    proposals: s.proposals.map((q) => (q.id === id ? { ...q, status: "proposed" as const } : q)),
    accepted: s.accepted.filter((a) => a !== id),
  };
  return replay(next);
}

/** Proposals that still need a human decision (blocks publishing). */
export const openProposals = (s: EditorState): EditProposal[] =>
  s.proposals.filter((p) => p.status === "proposed" || p.status === "blocked" || p.status === "conflict");
