import type { DraftDocument } from "./types";
import type { VersionHistory } from "./history";

/**
 * Party-drift check: does the clause text still name exactly the parties in `doc.parties`?
 *
 * The editor cannot change `doc.parties`, so any edit that makes clause text name someone else is drift. The check
 * compares a committed version with the history's FIRST version (the generated or uploaded document), never with a
 * baseline the caller chooses, so drift cannot be laundered by starting a new editor session from a drifted version.
 *
 * Kinds of drift:
 * - `missing`: a party name that a clause mentioned in the baseline is no longer mentioned by that (surviving) clause,
 *   or by any clause at all (removal or rename). This is per clause: shortening "Acme Widgets Ltd" to "Acme Widgets"
 *   inside a clause that used the full name counts as drift. Matching is whole-name (a letter, digit, mark, "_", soft
 *   hyphen or format character next to the name means it is a different word), case-insensitive, NFKC-normalised, with
 *   runs of whitespace treated as one space: "Alex Sample" matches "ALEX  SAMPLE" but not "Alex Samplerton". Runs of
 *   spaces are also collapsed before looking for new names, so extra spaces cannot split a name.
 * - `new_name`: clause text names someone who is neither a party nor already named in baseline clause text.
 * - `parties_changed`: the checked version's parties list differs from the baseline's.
 * - `role_mismatch`: text puts a party under another party's role, where the baseline did not: `Jordan Example (the
 *   "Provider")`, `Jordan Example, a company ... (hereinafter the "Provider")`, `Provider: Jordan Example`,
 *   `Jordan Example, as the Provider`. Other phrasings of a role swap are not detected.
 *
 * New-name rule (deterministic, no model). A name candidate is
 *   (a) a run of two or more Capitalised words on one line (joined by spaces, tabs or "&"); or
 *   (b) one or more Capitalised words that are attached to a party name (in the same run: "Acme Widgets Ltd Holdings",
 *       "New Acme Widgets Ltd"), or listed next to one ("Acme Widgets Ltd and Zenith", "Zenith, Acme Widgets Ltd"); or
 *   (c) one or more Capitalised words in a party-like position: `between X and Y`, `X ("Client")` / `X (the "Client")` /
 *       `X (hereinafter ...)`, `on behalf of X`, after a role label (`Client: X`, `the guarantor, X`), or after a title
 *       (`Mr X`, `Dr. X`).
 * "Capitalised" means the first letter is upper case (Unicode Lu); matching is case-sensitive, so lower-case prose in
 * those positions is never a candidate. A possessive "'s" is ignored. Leading function words ("The", "If", "Upon",
 * "Thereafter" ...) are dropped. A candidate made only of generic words (function words, common drafting terms such as
 * "Effective Date", "Force Majeure Event" or "Data Protection Act", job titles, number words, weekdays, months,
 * currencies, party roles, single letters, roman numerals, words with digits) is a defined term, not a name. An
 * ALL-CAPS run of four or more words is not taken whole: it is searched for two or more consecutive non-generic words
 * ("ZENITH HOLDINGS SHALL INDEMNIFY" gives "ZENITH HOLDINGS"). Invisible format characters and soft hyphens are
 * removed first, so "Zen<U+200B>ith Holdings" is "Zenith Holdings". The remaining candidate is a new name
 * unless its key (NFKC, lower case, letters/digits/spaces only) is a contiguous run of words of a party name ("Acme
 * Widgets" or "Widgets Ltd" for "Acme Widgets Ltd") or is already mentioned, whole-name, in baseline clause text.
 *
 * Known limits (each fails one way or the other, as stated):
 * - Missed: lower-case names ("riley sample"); names in scripts without case (CJK); a single Capitalised word outside
 *   the positions above ("assign this Agreement to Globex", "Hewlett-Packard" is one word); a name split across a line
 *   break; lower-case particles split a name ("Anna van der Berg", "Bank of America"); a company name made only of
 *   generic words ("First Data Bank", "First Group"); an initial breaks a name ("J. Smith" is one word after the
 *   dot); party names containing lower-case words or digits ("Bank of X") are not used for the "attached to a party"
 *   rule; a short form of a party name used for someone else; a
 *   one-word name in an ALL-CAPS passage; a non-party the BASELINE already names (the check compares with the
 *   baseline, it does not re-verify the generated or uploaded text itself), and a party the baseline never names is
 *   never reported missing.
 * - Reported (fails closed): a newly added capitalised term that is not in the generic list ("Service Level Agreement",
 *   "Steering Board", "New York" if the baseline never mentioned it). Undo the edit, or regenerate from an updated
 *   template. Expect this on new defined terms; the generic list covers common drafting vocabulary only.
 * - Clause text longer than MAX_CHECKED_CLAUSE characters, or a document longer than MAX_CHECKED_DOCUMENT, is refused
 *   rather than scanned.
 * - Only clause text is checked, not headings or the title.
 */

export type PartyDrift = { kind: "missing" | "new_name" | "parties_changed" | "role_mismatch"; name: string };

const norm = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const key = (t: string) =>
  norm(t).replace(/['’]s(?![\p{L}\p{N}])/gu, "").replace(/['’]/g, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/ +/g, " ").trim();
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EDGE = String.raw`[\p{L}\p{M}\p{N}_\u00ad\p{Cf}]`;
const whole = (name: string) => new RegExp(`(?<!${EDGE})${esc(name)}(?!${EDGE})`, "u");
/** Whole-name match of an already-normalised name in text. */
const mentionsNorm = (text: string, name: string) => whole(name).test(norm(text));

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const HONORIFICS = set("mr mrs ms mx dr miss prof");
const FUNCTION_WORDS = set(`
  the this that these those each either neither any all such no both a an if in on upon for by to under unless where
  when within after before subject except notwithstanding its their our your his her of and or as at from with without
  save provided following during until including is are be been was were not nor so then thereafter
  therefore however accordingly otherwise additionally further furthermore also only whereas whereupon hereby herein
  hereunder nothing once while although though because since whether witness whereof via
  mr mrs ms mx dr miss prof`);
const DRAFTING_WORDS = set(`
  agreement agreements services service client clients customer customers provider providers supplier suppliers
  contractor consultant company party parties effective date dates term terms fee fees schedule schedules exhibit
  appendix annex section sections clause clauses confidential information intellectual property rights governing law
  laws force majeure business day days deliverable deliverables work works statement order purchase payment payments
  invoice invoices notice notices termination liability limitation indemnity indemnification warranty warranties scope
  commencement start end expiry renewal data personal protection materials material product products software
  documentation retainer matter engagement letter standard total amount price charges expenses tax taxes vat general
  provisions definitions interpretation dispute resolution assignment entire variation waiver severability counterparts
  event events act acts regulation regulations directive rules rule code conduct policy policies plan arbitration court
  courts authority government consent bank transfer account email working calendar public holiday holidays hour hours
  week weeks month months year years quarter dollars dollar pounds sterling euros currency us usa uk eu chief executive
  officer officers director directors manager representative representatives authorised authorized signatory
  subcontractor subcontractors affiliate affiliates group member members personnel staff level key performance
  indicator indicators change control procedure good industry practice insolvency processor controller modern slavery
  high professional insurance time eastern western central pacific maximum extent permitted applicable warranty
  guarantor guarantee approval approved acceptance criteria milestone milestones support maintenance security breach
  one two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty sixty ninety
  hundred thousand million first second third final monday tuesday wednesday thursday friday saturday sunday january
  february march april may june july august september october november december shall will must
  form subscription request master non disclosure infringement nda due usage credit credits committee steering united states
  kingdom gdpr continuity background foreground ip net delivery acceptance implied express merchantability fitness
  particular purpose kind non-infringement accuracy consequential indirect special incidental punitive damages loss
  losses profits revenue goodwill liable indemnify negligence fraud wilful misconduct death injury compliance audit
  records report reports review reviews training access level levels per annum diem`);
const COMPANY_SUFFIX = set("ltd limited llc llp lp inc incorporated corp corporation plc gmbh ag sa sarl bv nv pty co");
const ROMAN = /^[IVXLCDM]+$/;

const WORD = String.raw`\p{Lu}[\p{L}\p{M}\p{N}'’\-]*`;
const SEP = String.raw`(?:[\p{Zs}\t]{1,8}|[\p{Zs}\t]{0,8}&[\p{Zs}\t]{0,8})`;
const RUN = `${WORD}(?:${SEP}${WORD})*`;
const RUN_RE = new RegExp(RUN, "gu");
const WORD_RE = new RegExp(WORD, "gu");
const CONNECT = /^[\p{Zs}\t]{0,8}(?:,|and|or|&)[\p{Zs}\t]{0,8}$/u;
const INTRO = new RegExp(`\\(\\s{0,8}(?:the\\s{1,8}|[Hh]ereinafter\\s{1,8})?(?:["“'‘]|called\\b|referred\\b)`, "gu");
const INTRO_GAP = /^\s{0,8},?\s{0,8}$/u;
/** Longest clause text the check reads; longer text is refused (fail closed) rather than scanned slowly. */
export const MAX_CHECKED_CLAUSE = 20_000;
const INVISIBLE = new RegExp(`[\\p{Cf}\u00ad\u034f\u17b4\u17b5]|(?<![\\p{L}\\p{M}])\\p{Mn}+`, "gu");
// Letters and symbols that render blank (braille blank, Hangul fillers) separate words like a space.
const BLANK = /[\u2800\u3164\u115f\u1160\uffa0]/gu;
/** Longest document (all clause text) the check reads. */
export const MAX_CHECKED_DOCUMENT = 100_000;
const LINE = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

type Tok = { w: string; k: string; start: number; end: number };
type Ctx = { partyKeys: string[][]; roleWords: Set<string>; byFirst: Map<string, string[][]> };

/** Words of a run with their offsets in `src`; a possessive "'s" is not part of the word. */
function tokens(src: string, from = 0, to = src.length): Tok[] {
  const out: Tok[] = [];
  for (const m of src.slice(from, to).matchAll(WORD_RE)) {
    const w = m[0].replace(/['’]s$/u, "");
    out.push({ w, k: key(w), start: from + m.index, end: from + m.index + w.length });
  }
  return out;
}

function isGeneric(t: Tok, ctx: Ctx): boolean {
  if (!t.k || ROMAN.test(t.w) || /\p{N}/u.test(t.w)) return true;
  // A hyphenated word ("Non-Disclosure") is generic when each part is.
  return t.k.split(" ").every((k) => FUNCTION_WORDS.has(k) || DRAFTING_WORDS.has(k) || ctx.roleWords.has(k) || [...k].length === 1);
}
const isCaps = (t: Tok) => t.w === t.w.toUpperCase() && t.w !== t.w.toLowerCase();

/** True when `ks` is a contiguous run of words of some party name. */
function partOfParty(ks: string[], ctx: Ctx): boolean {
  return ctx.partyKeys.some((p) => {
    for (let i = 0; i + ks.length <= p.length; i++) if (ks.every((w, j) => p[i + j] === w)) return true;
    return false;
  });
}

/** Split tokens around every party name they contain (left to right, longest name first). `attached` marks a segment
 * that touches a party name. Iterative, so a run of many party names cannot overflow the stack. */
function segments(ts: Tok[], ctx: Ctx): { segs: { seg: Tok[]; attached: boolean }[]; hadParty: boolean } {
  const parties = ctx.byFirst;
  const segs: { seg: Tok[]; attached: boolean }[] = [];
  let cur: Tok[] = [];
  let hadParty = false; // once true, the current segment starts right after a party name
  for (let i = 0; i < ts.length;) {
    const p = parties.get(ts[i].k)?.find((q) => i + q.length <= ts.length && q.every((w, j) => ts[i + j].k === w));
    if (p) {
      if (cur.length) segs.push({ seg: cur, attached: true });
      cur = [];
      hadParty = true;
      i += p.length;
    } else {
      cur.push(ts[i]);
      i++;
    }
  }
  if (cur.length) segs.push({ seg: cur, attached: hadParty });
  return { segs, hadParty };
}

/** Candidate names in one clause text, as written. */
function candidates(text: string, ctx: Ctx, roles: string[]): string[] {
  const out: string[] = [];
  const emit = (src: string, ts: Tok[], minWords: number) => {
    let i = 0;
    let titled = false;
    while (i < ts.length && FUNCTION_WORDS.has(ts[i].k)) { if (HONORIFICS.has(ts[i].k)) titled = true; i++; }
    const ws = ts.slice(i);
    if (ws.length < (titled ? 1 : minWords) || ws.every((t) => isGeneric(t, ctx))) return;
    if (ws.length >= 4 && ws.every(isCaps)) {
      // An ALL-CAPS passage (a disclaimer, an indemnity) is not one name: look inside it for two or more consecutive
      // non-generic words ("ZENITH HOLDINGS SHALL INDEMNIFY" gives "ZENITH HOLDINGS").
      let sub: Tok[] = [];
      const flush = () => { if (sub.length >= 2) out.push(src.slice(sub[0].start, sub[sub.length - 1].end)); sub = []; };
      for (const w of ws) { if (isGeneric(w, ctx) && !COMPANY_SUFFIX.has(w.k)) flush(); else sub.push(w); }
      flush();
      return;
    }
    out.push(src.slice(ws[0].start, ws[ws.length - 1].end));
  };
  const consider = (src: string, ts: Tok[], minWords: number) => {
    for (const { seg, attached } of segments(ts, ctx).segs) emit(src, seg, attached ? 1 : minWords);
  };
  // Invisible format characters and soft hyphens render as nothing, so they must not split a word ("Zen\u200bith").
  // Runs of spaces collapse when rendered, so they collapse here too (the separators below allow at most 8).
  const t = text.normalize("NFKC").replace(INVISIBLE, "").replace(BLANK, " ").replace(/[\p{Zs}\t]+/gu, " ");
  const roleAlt = [...new Set([...roles, "client", "provider", "customer", "supplier", "contractor", "consultant", "guarantor"]
    .map((r) => r.trim()).filter(Boolean)
    .flatMap((r) => [r, r[0].toUpperCase() + r.slice(1), r[0].toLowerCase() + r.slice(1)]))].map(esc).join("|");
  const positional = [
    new RegExp(`\\b[Bb]etween\\s{1,8}(${RUN})(?:\\s{0,8},?\\s{1,8}and\\s{1,8}(${RUN}))?`, "dgu"),
    new RegExp(`\\b[Oo]n\\s{1,8}behalf\\s{1,8}of\\s{1,8}(${RUN})`, "dgu"),
    new RegExp(`\\b(?:${roleAlt})\\s{0,8}[,:]\\s{0,8}(${RUN})`, "dgu"),
    new RegExp(`\\b(?:Mr|Mrs|Ms|Mx|Dr|Miss|Prof)\\.?\\s{1,8}(${RUN})`, "dgu"),
  ];
  for (const line of t.split(LINE)) {
    const runs = [...line.matchAll(RUN_RE)].map((m) => {
      const ts = tokens(line, m.index, m.index + m[0].length);
      return { start: m.index, end: m.index + m[0].length, ts, hadParty: segments(ts, ctx).hadParty };
    });
    runs.forEach((r, j) => {
      const prev = runs[j - 1], next = runs[j + 1];
      const listed = (prev?.hadParty && CONNECT.test(line.slice(prev.end, r.start))) ||
        (next?.hadParty && CONNECT.test(line.slice(r.end, next.start)));
      consider(line, r.ts, listed ? 1 : 2);
    });
    // Defined-term introduction `X ("Client")`: find each opening, then the run that ends just before it (linear).
    let ri = -1;
    for (const m of line.matchAll(INTRO)) {
      while (ri + 1 < runs.length && runs[ri + 1].end <= m.index) ri++;
      const r = ri >= 0 ? runs[ri] : undefined;
      if (r && INTRO_GAP.test(line.slice(r.end, m.index))) consider(line, r.ts, 1);
    }
    for (const re of positional) {
      for (const m of line.matchAll(re)) {
        for (let g = 1; g < m.length; g++) {
          const at = m.indices?.[g];
          if (m[g] && at) consider(line, tokens(line, at[0], at[1]), 1);
        }
      }
    }
  }
  return out;
}

function partiesChanged(base: DraftDocument, doc: DraftDocument): PartyDrift[] {
  const sig = (d: DraftDocument) => d.parties.map((p) => `${norm(p.role)}\u0000${norm(p.name)}`);
  const a = sig(base), b = sig(doc);
  const out: PartyDrift[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push({ kind: "parties_changed", name: doc.parties[i]?.name ?? base.parties[i]?.name ?? "" });
  }
  return out;
}

/**
 * (name, role) pairs, normalised and joined by NUL, where `d`'s clause text puts a party under a role that is another
 * party's and not its own (two parties may share a role). Forms: `Name ... (the "Role")` / `(hereinafter [referred to
 * as | called] the "Role")` with up to 160 characters between and no other party's name in them, `Role: Name`, and
 * `Name, as the Role`; in the last two the role must be capitalised, so prose ("as provider of the data") is not a swap.
 */
function roleMismatches(d: DraftDocument, parties: DraftDocument["parties"]): Set<string> {
  const out = new Set<string>();
  const ps = parties.map((p) => ({ name: norm(p.name), role: norm(p.role) })).filter((p) => p.name && p.role);
  const allRoles = new Set(ps.map((p) => p.role));
  const own = new Map<string, Set<string>>();
  for (const p of ps) own.set(p.name, new Set([...(own.get(p.name) ?? []), p.role]));
  const wrong = (name: string, role: string) => allRoles.has(role) && !own.get(name)?.has(role);
  const END = `(?![\\p{L}\\p{M}\\p{N}_'’]|${EDGE})`;
  for (const c of d.clauses) {
    const cased = c.text.replace(INVISIBLE, "").replace(BLANK, " ").normalize("NFKC").replace(/\s+/g, " ").trim();
    const t = cased.toLowerCase();
    for (const p of ps) {
      const n = esc(p.name);
      const intro = new RegExp(`(?<!${EDGE})${n}(?!${EDGE})([^()"“”]{0,160}?)\\(\\s?(?:hereinafter\\s)?(?:(?:referred\\sto\\s|called\\s)(?:as\\s)?)?(?:the\\s)?["“'‘]([^"”'’]{1,40})["”'’]`, "gu");
      for (const m of t.matchAll(intro)) {
        if (ps.some((q) => q.name !== p.name && whole(q.name).test(m[1]))) continue;
        const role = norm(m[2]);
        if (wrong(p.name, role)) out.add(`${p.name}\u0000${role}`);
      }
      for (const role of allRoles) {
        if (!wrong(p.name, role)) continue;
        // Matched case-insensitively on the cased text, so offsets are exact; the role itself must start upper case.
        const r = esc(role);
        const label = new RegExp(`(?<!${EDGE})(${r})\\s?:\\s?${n}(?!${EDGE})`, "giu");
        const as = new RegExp(`(?<!${EDGE})${n},?\\sas\\s(?:the\\s|a\\s)?(${r})${END}`, "giu");
        for (const m of [...cased.matchAll(label), ...cased.matchAll(as)]) {
          if (/^\p{Lu}/u.test(m[1])) out.add(`${p.name}\u0000${role}`);
        }
      }
    }
  }
  return out;
}

/** All drift of `doc` relative to `base`. Empty means the clause text and the parties list still agree. */
export function partyDriftBetween(base: DraftDocument, doc: DraftDocument): PartyDrift[] {
  for (const d of [base, doc]) {
    let total = 0;
    for (const c of d.clauses) {
      const len = c.text.normalize("NFKC").length;
      if (len > MAX_CHECKED_CLAUSE) throw new Error(`clause ${c.number ?? c.id} is longer than ${MAX_CHECKED_CLAUSE} characters`);
      total += len;
    }
    if (total > MAX_CHECKED_DOCUMENT) throw new Error(`the clause text is longer than ${MAX_CHECKED_DOCUMENT} characters in total`);
  }
  const drift: PartyDrift[] = [...partiesChanged(base, doc)];
  for (const party of doc.parties) {
    const name = norm(party.name);
    if (!name) continue;
    const baseAnywhere = base.clauses.some((c) => mentionsNorm(c.text, name));
    const anywhere = doc.clauses.some((c) => mentionsNorm(c.text, name));
    const lost = base.clauses.some((b) => {
      if (!mentionsNorm(b.text, name)) return false;
      const now = doc.clauses.find((c) => c.id === b.id);
      return now !== undefined && !mentionsNorm(now.text, name);
    });
    if ((baseAnywhere && !anywhere) || lost) drift.push({ kind: "missing", name: party.name });
  }
  // role_mismatch: text puts a party under another party's role. Reported only when the baseline did not already.
  const baseSwaps = roleMismatches(base, doc.parties), docSwaps = roleMismatches(doc, doc.parties);
  const swapped = new Set([...docSwaps].filter((pair) => !baseSwaps.has(pair)).map((pair) => pair.split("\u0000")[0]));
  for (const party of doc.parties) {
    if (swapped.has(norm(party.name))) { drift.push({ kind: "role_mismatch", name: party.name }); swapped.delete(norm(party.name)); }
  }
  const roles = doc.parties.map((p) => p.role);
  const partyKeys = doc.parties.map((p) => key(p.name).split(" ").filter(Boolean)).filter((p) => p.length);
  const byFirst = new Map<string, string[][]>();
  for (const pk of [...partyKeys].sort((a, b) => b.length - a.length)) byFirst.set(pk[0], [...(byFirst.get(pk[0]) ?? []), pk]);
  const ctx: Ctx = { partyKeys, roleWords: new Set(roles.flatMap((r) => key(r).split(" ")).filter(Boolean)), byFirst };
  // Keys are letters, digits and single spaces, so whole-word containment is a padded substring test.
  const baseKeys = base.clauses.map((b) => ` ${key(b.text.replace(INVISIBLE, ""))} `);
  const seen = new Set<string>();
  for (const c of doc.clauses) {
    for (const cand of candidates(c.text, ctx, roles)) {
      const k = key(cand);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (partOfParty(k.split(" "), ctx)) continue;
      if (baseKeys.some((b) => b.includes(` ${k} `))) continue;
      drift.push({ kind: "new_name", name: cand });
    }
  }
  return drift;
}

export type PartyCheckResult = { ok: true; versionId: string; drift: PartyDrift[] } | { ok: false; reason: string };

/**
 * The check the approval gate runs: the LATEST committed version against the FIRST one. The history must come from
 * `commitVersion` (frozen), and the first version must be generated or uploaded, not an edit. Anything else, or any
 * error while checking, is `ok: false`, which the gate treats as a refusal.
 */
export function checkCommittedParties(history: VersionHistory): PartyCheckResult {
  try {
    const vs = history?.versions;
    if (!Array.isArray(vs) || vs.length === 0) return { ok: false, reason: "no committed version to check" };
    const first = vs[0], latest = vs[vs.length - 1];
    if (!Object.isFrozen(history) || !Object.isFrozen(vs) || !Object.isFrozen(first) || !Object.isFrozen(latest))
      return { ok: false, reason: "the version history was not built with commitVersion" };
    if (first.doc.origin.kind === "edit") return { ok: false, reason: "the first version is an edit, so there is no generated or uploaded baseline" };
    return { ok: true, versionId: latest.id, drift: partyDriftBetween(first.doc, latest.doc) };
  } catch (e) {
    return { ok: false, reason: `the party check could not run: ${(e as Error).message}` };
  }
}

export function describeDrift(drift: readonly PartyDrift[]): string {
  const part = (x: PartyDrift) =>
    x.kind === "missing" ? `no longer names ${JSON.stringify(x.name)}`
      : x.kind === "new_name" ? `names ${JSON.stringify(x.name)}, who is not in the parties list`
        : x.kind === "role_mismatch" ? `introduces ${JSON.stringify(x.name)} under another party's role`
          : `parties list changed at ${JSON.stringify(x.name)}`;
  return `clause text and parties disagree: ${drift.map(part).join("; ")}; undo the edit, or change the parties list and regenerate`;
}
