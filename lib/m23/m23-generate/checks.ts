import type { Clause, DraftDocument } from "../shared/agreement-model";
import type { AgreementTemplate } from "./types";

const INJECTION: [string, RegExp][] = [
  ["ignore/disregard previous instructions", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|terms?|parties|constraints?)\b/i],
  ["system/assistant role text", /\b(system prompt|system message|developer message|assistant:|system:|as an ai|you are now|you are a|act as|pretend (to be|you))\b/i],
  ["model directive", /\b(do not|don't|never) (mention|tell|reveal|follow)\b/i],
  ["change-the-terms directive", /\b(change|replace|swap|set|make)\b[^.\n]{0,30}\b(the )?(fee|price|amount|party|parties|client|provider|landlord|tenant|governing law|date)\b[^.\n]{0,20}\b(to|as)\b/i],
  ["markup/template injection", /\{\{|<\/?(script|system|assistant|instructions?)\b|```/i],
  ["chat-template token", /<\|[^\n]{0,40}?\|>|\bim_(start|end|sep)\b|\[\/?INST\]|<<\/?SYS>>|<\/?s>|^\s*(system|assistant|developer)\s*[:>\n]/im],
  ["URL or email", /https?:\/\/|\bwww\.|\b[\w.+-]+@[\w-]+\.\w+/i],
  ["tag or header markup", /<\/?[A-Za-z_|][^<>\n]{0,40}>|^\s*#{2,}/m],
  ["role header", /^\s*(human|user|assistant|developer|model|bot)\s*:/im],
  ["override directive", /\b(ignore|disregard|forget|override)\b[\s\S]{0,80}\b(instructions?|guidance|rules?|prompts?|directions?)\b|\b(instructions?|guidance|rules?)\b[\s\S]{0,40}\b(void|cancell?ed|replaced|obsolete|no longer apply)\b|\bnew (task|instructions?|rules?|role)\b|\byou (now )?(work|act|are working) for\b/i],
  ["edit-the-agreement directive", /\b(add|insert|remove|delete|drop|strike)\s+(?:(?:a|an|the|any|all|every|new|extra)\s+)*(clauses?|terms?|provisions?|non-?competes?|sections?|dut(?:y|ies)|obligations?|waivers?)\b|\b(in|to) (the )?[\w']+ favou?r\b|\bfavou?r(ing)? the (client|provider|landlord|tenant|disclosing|receiving)\b|\btilt\b[\s\S]{0,40}\btoward|\btoward(s)? the (client|provider|landlord|tenant|disclosing|receiving)\b/i],
  ["paraphrased override", /\b(disregard|ignore|forget) (what|everything|anything)\b|\bpay no attention\b|\bwhat (came|comes|was said) (before|earlier|above)\b|\bwhat you were (told|given)\b|\byour (real|true|actual|new) (job|task|role|goal|instructions?)\b|\bcarr(y|ies) (every|all) (the )?risks?\b/i],
];
/** Same directives with spacing and punctuation squeezed out ("I g n o r e", "ig-nore"): letters only, lower case. */
const SQUEEZED = /ignore\w{0,30}(previous|prior|above|earlier)\w{0,30}(instruction|rule|prompt)|disregard\w{0,30}(instruction|rule|prompt)|systemprompt|developermessage|youarenow/;

/** Invisible and formatting characters: zero-width, bidi controls, fillers, variation selectors, soft hyphen. */
const INVISIBLE = /[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0]/gu;
/** Cyrillic and Greek letters that look like Latin ones (after lower-casing). */
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ɡ: "g",
  ı: "i", ə: "e", ɑ: "a", ø: "o", đ: "d", ł: "l", æ: "ae", œ: "oe", þ: "th", ð: "d", ß: "ss", "€": "e", "£": "l", ɩ: "i", ʟ: "l", ɢ: "g", ɪ: "i", ɴ: "n", ʀ: "r", ꜱ: "s", ᴀ: "a", ᴄ: "c", ᴅ: "d", ᴇ: "e", ᴏ: "o", ᴘ: "p", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ᴢ: "z", ʜ: "h", ᴋ: "k", ᴍ: "m", ʏ: "y",
  α: "a", β: "b", ε: "e", ζ: "z", η: "h", ι: "i", κ: "k", μ: "m", ν: "n", ο: "o", ρ: "p", τ: "t", υ: "y", χ: "x", ϲ: "c", ϳ: "j",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "g");

/** Fold text for scanning: compatibility forms (fullwidth etc.), accents, invisible characters and look-alike letters removed. */
export function foldForScan(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").toLowerCase().replace(CONFUSABLE_RE, (ch) => CONFUSABLE[ch]).normalize("NFKC");
}

/** Names of instruction-like patterns found in text (empty when clean). Scans the raw text and a folded copy. */
export function scanInjection(text: string): string[] {
  const folded = foldForScan(text);
  const hits = INJECTION.filter(([, re]) => re.test(text) || re.test(folded)).map(([name]) => name);
  const leet = folded.replace(/[0134578@$|!]/g, (c) => ({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "|": "i", "!": "i" })[c] ?? c);
  const squeezed = leet.replace(/[^a-z]/g, "");
  if (!hits.length && (SQUEEZED.test(squeezed) || SQUEEZED.test([...squeezed].reverse().join("")))) hits.push("spaced-out, look-alike or reversed directive");
  if (!hits.length && INJECTION.some(([, re]) => re.test(leet))) hits.push("look-alike directive");
  // Base64/hex-like runs: 24+ characters without a space that mix upper case, lower case and digits or + /.
  if ((text.match(/[A-Za-z0-9+/=]{24,}/g) ?? []).some((r) => /[A-Z]/.test(r) && /[a-z]/.test(r) && /[0-9+/]/.test(r))) hits.push("encoded text");
  return hits;
}

/**
 * Characters that hide or disguise text: invisible/format characters, and anything outside a small allow-list
 * (fullwidth and ligature forms, other scripts, look-alike Latin letters). Used to withhold user notes from the model: a tone hint never needs them.
 */
export function disguisedCharacters(text: string): string[] {
  const out: string[] = [];
  if (new RegExp(INVISIBLE.source, "u").test(text)) out.push("invisible or formatting characters");
  // Allow-list: printable ASCII, tab/newline, accented Latin letters and common typographic punctuation. Anything
  // else (other scripts, small capitals, dotless i, symbols) withholds the notes: a tone hint never needs it.
  const rest = text.normalize("NFC").replace(/[\t\n\r\x20-\x7e\u00a0\u00a3\u20ac\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022]/g, "");
  if ([...rest].some((ch) => !isPlainLatinLetter(ch))) out.push("unusual or non-Latin characters");
  return out;
}

const LATIN_EXTRA = new Set([..."ßæøœđłþðÆØŒĐŁÞÐıİəƏ"]);
/** A Latin letter that is an ASCII letter plus accents (é, ü, ñ) or a common European letter (ß, ø, ł). */
export function isPlainLatinLetter(ch: string): boolean {
  if (/^[A-Za-z]$/.test(ch) || LATIN_EXTRA.has(ch)) return true;
  return /\p{Script=Latin}/u.test(ch) && /^[A-Za-z]$/.test(ch.normalize("NFKD").replace(/\p{M}/gu, ""));
}

/** Latin-script letters that are not plain or accented ASCII letters: small capitals, dotless i, Latin alpha, etc. */
export function oddLatinLetters(text: string): boolean {
  return [...text].some((ch) => /\p{Script=Latin}/u.test(ch) && /\p{L}/u.test(ch) && !isPlainLatinLetter(ch));
}

/** Scripts whose letters are confused with each other. A name mixing two of them is refused. */
export function mixedConfusableScripts(text: string): boolean {
  const scripts = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u].filter((re) => re.test(text));
  return scripts.length > 1;
}

/** Words a jurisdiction or address never needs: modal, negation, payment and rights words, and party references. */
const OPERATIVE = new Set(("shall must cannot not no never without except unless agree agrees undertake undertakes required obligated responsible guarantee guarantees warrant warrants indemnify indemnifies " +
  "pay pays paid payable owe owes owed fee fees rent deposit deposits refund refunds keep keeps retain retains waive waives waiver forfeit forfeits liable liability penalty penalties damages terminate terminates " +
  "assign assigns license licence transfer transfers party parties interest accrue accrues accrued percent percentage rate rates charge charges cost costs expenses " +
  "arbitration arbitrate arbitrator binding jurisdiction venue dispute disputes jury trial claims exclusive exclusively only solely owns option months years year " +
  "any but sublet sublease permitted allowed prohibited included excluded utilities repairs repair maintained maintenance pets bears void monthly annually weekly daily").split(" "));
/** Operative words, role names or party names inside a free-text term value (empty when it is only a name/address). */
/** Stems that make a word operative wherever they appear ("subletting", "nonrefundable", "reimburses"). */
const OPERATIVE_STEMS = /^(?:non)?(sublet|sublease|subleas|indemn|renew|refund|reimburs|arbitra|mediat|litig|lawsuit|jurisdic|waive|waiver|forfeit|liab|penalt|damage|terminat|cancel|notwithstand|deliverabl|uncapped|irrevocab|perpetu|surcharg|royalt|sublicen|interest|accru|exclusiv|warrant|guarant|obligat|oblig)/;
/** Extra words for licensedMaterial only (whole words), so ordinary addresses ("Sellwood Avenue") are unaffected. */
// Exact verb forms only: lower-case verbs are already refused by the material shape, so these catch Capitalised ones
// without rejecting product names such as "Seller Portal" or "Copyright Works".
const LICENCE_WORDS = /^(?:copy|copies|copying|copied|modify|modifies|modified|modifying|modification|modifications|sell|sells|selling|sold|resell|resells|reselling|resold|distribute|distributes|distributing|distribution|derivative|derivatives|derived|reproduce|reproduces|reproduction|exploit|exploits|exploitation|commercialise|commercialize|publish|publishes|published|adapt|adapts|adapted|adaptation|translate|translates|translated|sublicence|worldwide|everywhere|anywhere|elsewhere|unrestricted|unlimited|world|earth|globe|globally|international|internationally|universe|all|every|each|whole|it|them)$/;
export function operativeWords(text: string, partyRefs: string[], licenceTerm = false): string[] {
  const spaced = (s: string) => ` ${foldForScan(s).replace(/[^a-z0-9]+/g, " ").trim()} `;
  // "No." / "No" directly before a number is an address abbreviation ("No. 5 Sample Road"), not a negation.
  const words = foldForScan(text).replace(/\bno\.?\s+(?=\d)/g, " ").match(/[a-z]+/g) ?? [];
  const hit = [...new Set(words.filter((w) => OPERATIVE.has(w) || OPERATIVE_STEMS.test(w) || (licenceTerm && LICENCE_WORDS.test(w))))];
  for (const r of partyRefs) if (spaced(r).trim() && spaced(text).includes(spaced(r))) hit.push(r);
  return hit;
}

/** Comparison key for "is this the same name": folded, look-alikes mapped, only letters and digits kept. */
const SUFFIX: Record<string, string> = { limited: "ltd", incorporated: "inc", corporation: "corp", company: "co", llc: "llc", "l.l.c": "llc" };
export function nameSkeleton(name: string): string {
  const words = foldForScan(name).split(/[^a-z0-9]+/).filter(Boolean).map((w) => SUFFIX[w] ?? w);
  if (words[0] === "the") words.shift();
  // Latin look-alikes: rn/m, vv/w, l/1/I, 0/O.
  return words.join("").replace(/rn/g, "m").replace(/vv/g, "w").replace(/[l1]/g, "i").replace(/0/g, "o");
}

const NUMBER_WORDS = /\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|double|triple)\b/gi;
const MONTHS = /\b(january|february|march|april|june|july|august|september|october|november|december)\b|\bMay\s+\d/gi;
const NUMBERS = /\d[\d,]*(?:\.\d+)?/g;
const MODALS = /\b(shall|must|agrees? to|undertakes?|will|is required to|are required to|obligated|responsible for|guarantees?|warrants?|indemnif\w+)\b/gi;
const ENTITY = /\b[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*\s+(?:Inc|LLC|Ltd|LLP|Corp|Corporation|Company|GmbH|PLC|Co)\b\.?/g;

/** Figures, dates, percentages and amounts in a text: digits, number words, month names, currency/percent marks. */
export function protectedTokens(text: string): Set<string> {
  const t = new Set<string>();
  for (const m of text.match(NUMBERS) ?? []) t.add(m.replace(/[,.]+$/, "").toLowerCase());
  for (const m of text.match(NUMBER_WORDS) ?? []) t.add(m.toLowerCase());
  for (const m of text.match(MONTHS) ?? []) t.add(m.toLowerCase().replace(/\s+\d$/, ""));
  for (const m of text.match(/[$€£%]|\b(USD|EUR|GBP|CAD)\b/g) ?? []) t.add(m);
  return t;
}

/**
 * The only rewording the meaning check allows, besides spacing and typographic quotes/dashes: these
 * phrase swaps, each folded to one canonical spelling before comparing. Keep this list small and literal.
 */
const SWAPS: [RegExp, (m: string, ...g: string[]) => string][] = [
  [/\b(carry|carries|carried|carrying)\s+out\b/gi, (_m, v) => ({ carry: "perform", carries: "performs", carried: "performed", carrying: "performing" })[v.toLowerCase()]!],
  [/\b(?:(?:on|upon)\s+request|when\s+asked)\b/gi, () => "onrequest"],
  [/\b(?:begin|commence)(s?)\b/gi, (_m, s) => `start${s}`],
  [/\b(?:began|begun|commenced)\b/gi, () => "started"],
];
/** Punctuation a reword may add. Any other symbol (markup, entities, brackets, ?, !, :, newlines) must already be in the clause. */
const SAFE_PUNCT = new Set([..." .,;'\"()-\u00a0\u2018\u2019\u201c\u201d\u2013\u2014"]);

type Tok = { t: string; cap: boolean; initial: boolean };
/**
 * Meaning-bearing tokens in order: words (with defined-term capitalisation), signed figures, {{ref}} placeholders,
 * commas, brackets, quotes, apostrophes and dashes (each anchored where it stands, so a definition or parenthesis
 * cannot move), and a "§" for every sentence or clause break (. ; : ! ?). Trailing breaks are dropped.
 */
function meaningTokens(text: string): { toks: Tok[] } {
  let s = text.normalize("NFKC").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
  for (const [re, fn] of SWAPS) s = s.replace(re, (m: string, ...g: string[]) => { const r = fn(m, ...g); return /^[A-Z]/.test(m) ? r[0].toUpperCase() + r.slice(1) : r; });
  const toks: Tok[] = [];
  let atStart = true;
  // A sign, dash or spaced hyphen before a figure belongs to the figure ("-$5,000", "\u2013 30").
  for (const m of s.matchAll(/\{\{ref:[^}]+\}\}|(?:[-+\u2010-\u2015\u2212\ufe58\ufe63\uff0d][\s'"\u2018\u2019\u201c\u201d]*)?[$€£]?\s*\d(?:[\d,.]*\d)?%?|\p{L}+(?:'\p{L}+)*|[.;:!?]|,|[()"'\-\u2010-\u2015\u2212]/gu)) {
    const raw = m[0].replace(/\s+/g, "");
    if (/^[()"'\-\u2010-\u2015\u2212]$/.test(raw)) { toks.push({ t: raw.replace(/[\u2010-\u2015\u2212]/, "-"), cap: false, initial: false }); continue; }
    if (/^[.;:!?]$/.test(raw)) { toks.push({ t: "§", cap: false, initial: false }); atStart = true; continue; }
    if (raw === ",") { toks.push({ t: ",", cap: false, initial: false }); continue; }
    const t = raw.toLowerCase();
    const initial = atStart;
    atStart = false;
    toks.push({ t, cap: /^\p{Lu}/u.test(raw), initial });
  }
  while (toks.length && toks[toks.length - 1].t === "§") toks.pop();
  return { toks };
}

/** Longest common subsequence of token strings; returns the matched index pairs. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}

/**
 * Structural meaning check, fail-closed: after folding the allowed SWAPS, the candidate's token sequence must equal
 * the template clause's. So no sentence, word, comma or figure of the template may disappear
 * or move (restrictive words like "only", "indirect or", "written" included), no word may be added or dropped, breaks,
 * brackets, quotes and dashes stay where they are, units such as "per month" stay verbatim, a figure keeps its sign, and defined-term capitals stay.
 */
export function meaningChanges(id: string, base: string, cand: string): string[] {
  const a = meaningTokens(base), b = meaningTokens(cand);
  const reasons: string[] = [];
  const pairs = lcsPairs(a.toks.map((x) => x.t), b.toks.map((x) => x.t));
  const inA = new Set(pairs.map(([i]) => i)), inB = new Set(pairs.map(([, j]) => j));
  const removed = a.toks.filter((_, i) => !inA.has(i)).map((x) => x.t);
  const added = b.toks.filter((_, j) => !inB.has(j)).map((x) => x.t);
  const list = (xs: string[]) => [...new Set(xs)].slice(0, 8).join(", ");
  if (removed.length) reasons.push(`${id}: removes or moves template wording (${list(removed)})`);
  if (added.length) reasons.push(`${id}: adds wording not in the template (${list(added)})`);
  const unit = (s: string) => (s.match(/\b(?:per|each|every)\s+[A-Za-z]+/gi) ?? []).map((x) => x.toLowerCase().replace(/\s+/g, " ")).join("|");
  if (unit(base) !== unit(cand)) reasons.push(`${id}: unit of charge or frequency changed`);
  if (!removed.length && !added.length) {
    const caps = pairs.filter(([i, j]) => a.toks[i].cap !== b.toks[j].cap && !a.toks[i].initial && !b.toks[j].initial);
    if (caps.length) reasons.push(`${id}: capitalisation of a defined term changed (${list(caps.map(([i]) => a.toks[i].t))})`);
  }
  return reasons;
}

/** Markup check: no symbol, entity or line break the template clause lacks (HTML, markdown, code, chat markup). */
export function markupChanges(id: string, base: string, cand: string): string[] {
  const baseChars = new Set(base);
  const odd = [...new Set(cand)].filter((ch) => !/[\p{L}\p{N}]/u.test(ch) && !SAFE_PUNCT.has(ch) && !baseChars.has(ch));
  const reasons: string[] = [];
  if (odd.length) reasons.push(`${id}: introduces markup or symbols not in the template (${odd.map((c) => JSON.stringify(c)).join(" ")})`);
  const lead = (s: string) => s.trimStart()[0] ?? "";
  if (lead(cand) !== lead(base) && !/[\p{L}\p{N}"\u201c(]/u.test(lead(cand))) reasons.push(`${id}: starts with a list or heading marker`);
  const ent = (s: string) => (s.match(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);?/gi) ?? []).length;
  if (ent(cand) > ent(base)) reasons.push(`${id}: introduces an HTML entity`);
  // Quotes and brackets mark defined terms ("the \"Premises\""): their sequence must stay as in the template.
  const marks = (s: string) => s.replace(/[\u201c\u201d]/g, '"').replace(/[^()"]/g, "");
  if (marks(cand) !== marks(base)) reasons.push(`${id}: quotation marks or brackets changed`);
  return reasons;
}

/** Words that change who owes what, how often or how much; a reword may not bring in any the baseline lacks. */
const RISK_WORDS = new Set(("one first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth last next final several both single fortnight hour hours decade may once twice dozen day days week weeks month months year years annual annually weekly monthly quarterly daily business calendar " +
  "liable liability pay pays paid payable owe owes owed refund refunds assign assigns assigned assignment indemnify indemnifies waive waives waiver forfeit forfeits penalty penalties interest " +
  "only solely exclusively sole all every each any whole entire everything unlimited unconditional irrevocable perpetual perpetually automatically automatic renew renews renewal " +
  "exclusive transfer transfers ownership own owns title license licence guarantee warranty damages terminate terminates immediately unilaterally").split(" "));
const NEGATIONS = /\b(not|no|never|neither|nor|without|except|unless|cannot)\b|n't\b/gi;

const SENTENCE_STARTERS = new Set("the this these those that when whenever where if unless upon on in at after before during while once each either neither both any all such for to with by as under subject notwithstanding however in addition further also".split(" "));

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;
const words = (s: string) => new Set((s.toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[a-z][a-z']*/g) ?? []).map((w) => w.replace(/'+$/, "")));

/**
 * Compare model-reworded clauses against the template-filled baseline. Returns reasons (empty = acceptable).
 * Per clause: no protected token the baseline clause lacks, no more obligation words, no new entity names,
 * no instruction-like text, same {{ref}} placeholders.
 */
export function compareToBaseline(baseline: Clause[], candidate: Clause[], extraAllowedWords: string[], roles: string[] = [], keepVerbatim: string[] = []): string[] {
  const reasons: string[] = [];
  const mentionTerms = [...extraAllowedWords, ...roles].filter(Boolean).sort((a, b) => b.length - a.length);
  const escape = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionRe = mentionTerms.length ? new RegExp(mentionTerms.map(escape).join("|"), "g") : null;
  const baseById = new Map(baseline.map((c) => [c.id, c]));
  const vocab = new Set<string>(extraAllowedWords.flatMap((w) => [...words(w)]));
  for (const c of baseline) for (const w of words(`${c.heading ?? ""} ${c.text}`)) vocab.add(w);
  for (const cand of candidate) {
    const base = baseById.get(cand.id);
    if (!base) { reasons.push(`${cand.id}: unknown clause`); continue; }
    if (base.locked) {
      if (cand.text !== base.text) reasons.push(`${cand.id}: locked clause was changed`);
      continue;
    }
    const novel = [...new Set(cand.text.match(/[^\u0000-\u007f]/g) ?? [])].filter((ch) => !base.text.includes(ch) && !/[\u00a0\u2010-\u2015\u2018-\u201f\u2026]/.test(ch));
    if (novel.length) { reasons.push(`${cand.id}: introduces non-ASCII characters not in the template (${novel.join(" ")})`); continue; }
    if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(cand.text) && !/[\u0000-\u0008\u000e-\u001f\u007f]/.test(base.text)) { reasons.push(`${cand.id}: introduces control characters`); continue; }
    if (cand.text.length > base.text.length * 3 + 200) { reasons.push(`${cand.id}: text is far longer than the template`); continue; }
    reasons.push(...markupChanges(cand.id, base.text, cand.text), ...meaningChanges(cand.id, base.text, cand.text));
    const allowed = protectedTokens(base.text);
    const extra = [...protectedTokens(cand.text)].filter((t) => !allowed.has(t));
    if (extra.length) reasons.push(`${cand.id}: introduces figures/dates not in the input or template (${extra.join(", ")})`);
    if (count(MODALS, cand.text) > count(MODALS, base.text)) reasons.push(`${cand.id}: adds obligations or warranties`);
    for (const v of keepVerbatim) if (base.text.includes(v) && !cand.text.includes(v)) reasons.push(`${cand.id}: input value "${v}" was removed or altered`);
    const tokenSeq = (s: string) => [...(s.match(NUMBERS) ?? []), ...(s.match(NUMBER_WORDS) ?? []), ...(s.match(MONTHS) ?? [])].map((x) => x.toLowerCase().replace(/[,.]+$/, "")).join("|");
    if (tokenSeq(base.text) !== tokenSeq(cand.text)) reasons.push(`${cand.id}: figures/dates were dropped, added or reordered`);
    const seq = (s: string, re: RegExp) => (s.match(re) ?? []).map((x) => x.toLowerCase()).join("|");
    if (seq(cand.text, MODALS) !== seq(base.text, MODALS)) reasons.push(`${cand.id}: obligation words changed`);
    if (count(NEGATIONS, cand.text) !== count(NEGATIONS, base.text)) reasons.push(`${cand.id}: negations changed`);
    if (mentionRe && seq(cand.text, mentionRe) !== seq(base.text, mentionRe)) reasons.push(`${cand.id}: party mentions changed or reordered`);
    const baseWords = words(base.text.replace(/\bMay\s+\d/gi, " "));
    const newRisk = [...words(cand.text)].filter((w) => RISK_WORDS.has(w) && !baseWords.has(w));
    if (newRisk.length) reasons.push(`${cand.id}: introduces risk-bearing wording (${newRisk.join(", ")})`);
    const ents = (cand.text.match(ENTITY) ?? []).filter((e) => !base.text.includes(e));
    if (ents.length) reasons.push(`${cand.id}: introduces a party or entity name (${ents.join(", ")})`);
    for (const m of cand.text.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
      if (!vocab.has(m[0].toLowerCase()) && !SENTENCE_STARTERS.has(m[0].toLowerCase())) { reasons.push(`${cand.id}: introduces a new proper noun (${m[0]})`); break; }
    }
    const inj = scanInjection(cand.text.replace(/\{\{ref:[^}]+\}\}/g, "[ref]"));
    if (inj.length) reasons.push(`${cand.id}: instruction-like text (${inj.join(", ")})`);
    const refs = (s: string) => (s.match(/\{\{ref:[^}]+\}\}/g) ?? []).sort().join("|");
    if (refs(cand.text) !== refs(base.text)) reasons.push(`${cand.id}: cross-reference placeholders changed`);
    if (cand.text.trim().length < 20) reasons.push(`${cand.id}: text is empty or too short`);
  }
  return reasons;
}

/** Structural checks on a finished draft against the template and the validated input. */
export function checkDraft(draft: DraftDocument, template: AgreementTemplate, baseline: Clause[], parties: { role: string; name: string }[]): string[] {
  const reasons: string[] = [];
  const ids = draft.clauses.map((c) => c.id);
  if (new Set(ids).size !== ids.length) reasons.push("duplicate clause ids");
  for (const tc of template.clauses) {
    if (tc.required && !ids.includes(tc.id)) reasons.push(`required clause missing: ${tc.id}`);
  }
  draft.clauses.forEach((c, i) => {
    if (c.number !== String(i + 1)) reasons.push(`${c.id}: numbering is not sequential`);
    if (/\{\{/.test(c.text)) reasons.push(`${c.id}: unresolved placeholder`);
  });
  const baseById = new Map(baseline.map((c) => [c.id, c]));
  for (const tc of template.clauses.filter((c) => c.locked)) {
    const c = draft.clauses.find((x) => x.id === tc.id);
    if (c && (!c.locked || c.text.replace(/\{\{ref:[^}]+\}\}/g, "") !== (baseById.get(tc.id)?.text ?? "").replace(/\{\{ref:[^}]+\}\}/g, ""))) reasons.push(`${tc.id}: locked clause changed`);
  }
  if (JSON.stringify(draft.parties) !== JSON.stringify(parties.map((p) => ({ role: p.role, name: p.name.trim() })))) reasons.push("parties differ from the input");
  const partiesClause = draft.clauses.find((c) => c.id === "parties");
  for (const p of draft.parties) if (partiesClause && !partiesClause.text.includes(p.name)) reasons.push(`parties clause does not name ${p.role}`);
  return reasons;
}
