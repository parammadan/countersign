// Checks on an AI answer beyond "every figure appears in a cited passage":
//   - binding: a figure must belong to the term the answer attaches it to. "Late fees are 20 per month" is
//     rejected when the cited text says "invoices are due within 20 days" and "a late fee of 2% per month".
//   - absence: "the agreement doesn't specify a deadline" is a statement about the document, not a negated fact,
//     so it doesn't trip the negation check.
//   - calculations: arithmetic the model shows is re-done here, from numbers in the agreement or the question
//     only; a verified result may then appear in the answer.
// All of it is deterministic and bounded; none of it calls a model.
import { normalize } from "../understand/evidence";
import { GROUP_OF } from "./retrieve";

const MAX_TEXT = 6000;

// ---- absence statements ----
const ABSENCE: RegExp[] = [
  /\b(?:agreement|contract|document|letter|it|clause|section|passage|text|terms?)\s+(?:does|do|did)\s*(?:n['’]?t|not)\s+(?:\w+\s+)?(?:specify|state|say|mention|set out|give|define|address|include|provide|cover|explain|indicate|identify|list|name|require|contain|allow for)\b/g,
  /\b(?:there is|there's|there are|with|has|have|gives?|sets?|states?|contains?)\s+no\s+(?:specific|exact|fixed|set|particular|stated|defined|clear|explicit|express|separate|numeric|numerical)\b/g,
  /\bno\s+(?:specific|exact|fixed|set|particular|stated|defined|explicit|numeric|numerical)\s+(?:figure|number|amount|date|deadline|period|time|timeframe|time frame|term|duration|limit|cap|rate|percentage|fee|sum|notice period)\b/g,
  /\b(?:is|are|was|were|isn't|aren't)?\s*not\s+(?:specified|stated|defined|set out|given|mentioned|addressed|explained|identified|quantified)\b/g,
  /\b(?:not|never)\s+(?:say|state|specify|mention)\b/g,
  /\bnothing\s+(?:in\s+(?:the|this|it)\s*(?:agreement|contract|document)?\s*)?(?:requires|says|states|specifies|mentions|addresses|prevents|covers)\b/g,
];
/** The answer with statements about what the document doesn't say removed (for the negation check only). */
export function withoutAbsence(answer: string): string {
  let a = normalize(answer.slice(0, MAX_TEXT));
  // the phrase and what it says is missing ("doesn't state a number of days"), up to the next punctuation
  for (const re of ABSENCE) a = a.replace(new RegExp(`${re.source}(?:\\s+[a-z'-]+){0,5}`, "g"), " ");
  return a;
}

// ---- references to pages and clauses are labels, not figures ("page 2", "Clause 4.1", "sections 3 and 5") ----
export const stripPageRefs = (s: string) =>
  s.replace(/\b(?:pages?|clauses?|sections?|paragraphs?|articles?|schedules?|exhibits?|appendi(?:x|ces)|annex(?:es)?|§)\s*\(?\d{1,4}(?:\.\d{1,3})*[a-z]?\)?(?:\s*(?:,|and|&|-|–|to|or)\s*\(?\d{1,4}(?:\.\d{1,3})*[a-z]?\)?)*/gi, " ");

// ---- binding ----
const ROLES = ["client", "clients", "provider", "consultant", "firm", "company", "customer", "supplier", "contractor", "vendor", "agency", "licensor", "licensee", "landlord", "tenant", "buyer", "seller", "employer", "employee", "party", "parties", "counterparty"];
const UNIT_WORDS = /^(?:hours?|days?|weeks?|months?|years?|hourly|daily|weekly|monthly|yearly|annual|annually|percent|per|cent|dollars?|usd|business|calendar|working)$/;
const MONTHS = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;
const NUMBER_WORDS = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)$/;
const ANCHOR_STOP = new Set(
  ("the and for with this that from into are was were will shall must may can could would should has have had " +
    "its their there then than which who whom what when where each any all per of to in on at by an as be is it " +
    "agreement contract document under within after before upon following total amount number such other same " +
    "also only both either between including include includes included about there here these those those " +
    "answer says states stated provides provided according based therefore because since so if not no " +
    // who a clause is about is checked separately (roleSwaps); it doesn't say which term a figure belongs to
    ROLES.join(" ")).split(" "),
);
const IRREGULAR: Record<string, string> = { paid: "pay", owed: "owe", owing: "owe", due: "due", fees: "fee" };
export function stemWord(w: string): string {
  if (IRREGULAR[w]) return IRREGULAR[w];
  return w.replace(/(?:ations?|ments?|ings?|ables?|ibles?|ions?|ers?|ed|es|s|ly)$/, "").slice(0, 6) || w.slice(0, 6);
}
const PERIODS: [RegExp, string][] = [
  [/\b(?:per|an|a|each|every)\s+hour\b|\bhourly\b/, "@hour"],
  [/\b(?:per|a|each|every)\s+day\b|\bdaily\b/, "@day"],
  [/\b(?:per|a|each|every)\s+week\b|\bweekly\b/, "@week"],
  [/\b(?:per|a|each|every)\s+month\b|\bmonthly\b/, "@month"],
  [/\b(?:per|a|each|every)\s+(?:year|annum)\b|\b(?:yearly|annual|annually)\b/, "@year"],
];
/**
 * What a figure in a clause is about: its content words, stemmed, plus the rate it's charged at ("@hour" for
 * "per hour" or "hourly"). Rates are weaker evidence than content words; see unboundValues.
 */
export function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const n = normalize(text);
  for (const w of n.split(/[^\p{L}]+/u)) {
    if (w.length < 3 || ANCHOR_STOP.has(w) || UNIT_WORDS.test(w) || MONTHS.test(w) || NUMBER_WORDS.test(w)) continue;
    out.add(stemWord(w));
  }
  for (const [re, tag] of PERIODS) if (re.test(n)) out.add(tag);
  return out;
}
const isRate = (w: string) => w.startsWith("@");

type Kind = "money" | "percent" | "duration" | "plain";
type Value = { n: string; kind: Kind };
const NUMWORD_VALUES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, fifty: 50, sixty: 60, ninety: 90,
};
/** The figures in a clause with what kind of figure each is. Clause numbers ("4.", "4.1") at a start are skipped. */
export function valuesIn(text: string): Value[] {
  // a clause number at the start ("4.", "4.1.", "(b)") is a label, not a figure
  const s = normalize(text.slice(0, MAX_TEXT).replace(/^\s*\(?\d{1,3}(?:\.\d{1,3})*[.)]?\s+(?=[A-Z(“"])/, ""))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, " ");
  const out: Value[] = [];
  const re = /([$£€]|\b(?:usd|eur|gbp|cad|aud)\s?)?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\)\s*)?(%|percent|per\s?cent|dollars?\b|usd\b|euros?\b|eur\b|pounds?\b|gbp\b|(?:(?:business|calendar|working)\s+)?(?:hours?|days?|weeks?|months?|years?))?/g;
  for (const m of s.matchAll(re)) {
    const raw = m[2].replace(/,/g, "");
    if (!raw || Number.isNaN(Number(raw))) continue;
    // a year in a date ("2027") or a day of month next to a month name is a date, checked elsewhere
    const before = s.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
    if (/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/.test(before) || /^\d{4}$/.test(raw) && !m[1] && !m[3]) continue;
    const kind: Kind = m[1] || (m[3] && /dollar|usd|euro|eur|pound|gbp/.test(m[3])) ? "money" : m[3] ? (/%|cent/.test(m[3]) ? "percent" : "duration") : "plain";
    out.push({ n: String(Number(raw)), kind });
  }
  // "thirty (30) days" style figures are already digits; spelled-out-only figures are rare in answers
  for (const m of s.matchAll(/\b([a-z]+(?:-[a-z]+)?)\s+(days?|weeks?|months?|years?)\b/g)) {
    const v = NUMWORD_VALUES[m[1]];
    if (v !== undefined) out.push({ n: String(v), kind: "duration" });
  }
  return out;
}
const compatible = (a: Kind, b: Kind) => a === b || a === "plain" || b === "plain";

/** Passage text split into sentences and semicolon clauses: the unit a figure belongs to in the agreement. */
export function segments(text: string): string[] {
  return text.slice(0, MAX_TEXT * 4).split(/(?<=[.!?])\s+(?=[A-Z0-9("“])|;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}
/** Answer text split finer, into clauses, so "invoices are due in 30 days and late fees are 2%" is two claims. */
function clauses(text: string): string[] {
  return stripPageRefs(text.slice(0, MAX_TEXT)).split(/(?<=[.!?])\s+|;\s*|\n+|,?\s+(?:and|but|while|whereas|plus)\s+/i).map((s) => s.trim()).filter(Boolean);
}

type Seg = { t: string; a: Set<string>; v: Value[] };
/** Cited text as sentences, each with its figures and what it's about (a heading counts toward the next one). */
export function supportSegments(support: string[]): Seg[] {
  const segs: Seg[] = [];
  for (const passage of support) {
    let heading: Set<string> | null = null;
    for (const t of segments(passage)) {
      const v = valuesIn(t);
      // a clause heading ("2. Term.", "Fees and payment.") names what the next sentence is about
      if (!v.length && t.split(/\s+/).length <= 4) {
        heading = anchors(t);
        continue;
      }
      const a = anchors(t);
      if (heading) for (const w of heading) a.add(w);
      heading = null;
      segs.push({ t, a, v });
    }
  }
  return segs;
}

/**
 * Figures the answer attaches to a term the agreement gives a DIFFERENT figure, while no cited sentence links
 * this figure to that term. Results of verified calculations (`skip`) aren't checked. Figures the user put in the
 * question (`fromQuestion`) may be repeated, but not when the agreement gives that term a different figure of the
 * same kind ("Is the fee $5,000?" when it's $3,200). Figures whose term can't be judged aren't reported.
 */
export function unboundValues(answer: string, support: string[], question = "", skip: Set<string> = new Set(), fromQuestion: Set<string> = new Set(), scenario: Set<string> = new Set()): string[] {
  const segs = supportSegments(support);
  const out: string[] = [];
  let prev = new Set<string>();
  const qAnchors = anchors(question);
  for (const c of clauses(answer)) {
    let a = anchors(c);
    if (!a.size) a = prev.size ? prev : qAnchors;
    prev = a;
    if (!a.size) continue;
    // content words bind a figure when they're about something in the cited text; otherwise its rate may
    const content = [...a].filter((w) => !isRate(w));
    const contentKnown = content.some((w) => segs.some((s) => s.a.has(w)));
    const binding = contentKnown ? content : [...a];
    const stated = valuesIn(c);
    const statedHere = new Set(stated.map((x) => x.n));
    // a scenario figure from the question ("if a $3,200 invoice is late") may be used where the answer is itself
    // conditional ("on a $3,200 invoice, ..."); stated as a fact it's checked like any other figure
    const conditional = /\b(?:if|assuming|suppos\w*|on an?|in that case|in your example|in this scenario)\b/i.test(c);
    for (const v of stated) {
      // "5% of $1,000" applies a stated rate to the user's own figure
      if (skip.has(v.n) || (scenario.has(v.n) && (conditional || /%\s+of\b/.test(c)))) continue;
      const withValue = segs.filter((s) => s.v.some((x) => x.n === v.n && compatible(x.kind, v.kind)));
      if (withValue.some((s) => binding.some((w) => s.a.has(w)))) continue;
      const asked = fromQuestion.has(v.n);
      // the answer's term has a different specific figure in the agreement: of the same kind (one number of days
      // for another), or of another kind when the wording matches strongly (a sum put where the days belong)
      const shared = (s: { a: Set<string> }) => [...a].filter((w) => s.a.has(w)).length;
      const conflicting = segs.filter((s) => {
        const k = shared(s);
        // a competing figure the answer also states in this clause explains the overlap; it isn't a swap
        return k > 0 && s.v.some((x) => x.n !== v.n && !statedHere.has(x.n) && x.kind !== "plain" && (x.kind === v.kind ? k >= 1 : !asked && k >= 2));
      });
      if (conflicting.length) out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
    }
  }
  return [...new Set(out)];
}

// ---- negations, per sentence ----
const NEG = /\b(?:\w+n['’]t|cannot|no|not|nothing|never|none|neither|nor|without|non-\w+)\b/;
const NEG_WORD = /\b(\w+n['’]t|cannot|no|not|nothing|never|none|neither|nor|without|non-\w+|waived?|free|zero)\b/g;
/** "No, ..." / "Yes, ..." opening a sentence is a reply, not a claim; "no later than" is a deadline, not a negation. */
const REPLY = /(^|[.!?]\s+)(?:no|yes)\s*[,.;:!—-]\s*/gi;
const BOUNDS = /\b(?:no|not)\s+(?:later|earlier|more|less|fewer|sooner)\s+than\b|\b(?:not|cannot|\w+n['’]t)\b[^.,;]{0,50}?\bwithout\b/g;
/**
 * Negations (and "waived", "free", "zero") in the answer that the cited text doesn't support where it talks about
 * the same thing: "Either party may not terminate" when the termination sentence has no negation is rejected
 * even if another cited sentence says "not refundable".
 */
export function unsupportedNegations(answer: string, support: string[], absenceFree: (s: string) => string): string[] {
  const segs = supportSegments(support).concat(support.flatMap(segments).map((t) => ({ t, a: anchors(t), v: [] as Value[] })));
  const all = normalize(support.join(" \n "));
  const out: string[] = [];
  for (const raw of clauses(answer.replace(REPLY, "$1"))) {
    const c = absenceFree(raw).replace(BOUNDS, " ");
    const words = [...c.matchAll(NEG_WORD)].map((m) => m[1]);
    if (!words.length) continue;
    const a = [...anchors(c)].filter((w) => !isRate(w));
    // the cited sentences most about the same thing (not any sentence sharing one word)
    const overlap = (s: { a: Set<string> }) => a.filter((w) => s.a.has(w)).length;
    const best = Math.max(0, ...segs.map(overlap));
    const near = best ? segs.filter((s) => overlap(s) === best) : [];
    for (const w of words) {
      const special = /^(?:waived?|free|zero)$/.test(w);
      const has = (t: string) => (special ? new RegExp(`\\b${w.replace(/d$/, "")}`).test(normalize(t)) : NEG.test(normalize(t)) || BOUNDS.test(normalize(t)));
      const ok = near.length ? near.some((s) => has(s.t)) : has(all);
      if (!ok) out.push(`"${w}"`);
    }
  }
  return [...new Set(out)];
}

// ---- who does what ----
const VERB = /\b(?:pays?|owes?|must|shall|will|may|agrees?|provides?|delivers?|gives?|terminates?|indemnif\w*|is (?:required|entitled|responsible)|has to|keeps?|bears?)\b/;
const PASSIVE = /\b(?:is|are|was|were|be|been|being|gets?)\s+(?:\w+\s+)?(?:paid|owed|given|provided|delivered|charged|invoiced|required|entitled|due|reimbursed)\b|\bby (?:the )?[a-z]/;
const ROLE_RE = new RegExp(`\\b(${ROLES.filter((r) => !/part/.test(r)).join("|")})\\b`);
/** Defined parties: 'Harrow Example Ltd ("Provider")' -> harrow example ltd = provider. */
export function partyRoles(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // the name is the run of capitalised words (and "&", "of", company suffixes) right before the label, so a title
  // like "CONSULTING AGREEMENT between ..." isn't taken as part of it
  // '("Provider")', '(the "Provider")', '(hereinafter "Provider")', '("Harrow" or the "Provider")'
  const label = String.raw`\(\s*(?:["“'][^"”'()]{1,40}["”']\s+or\s+)?(?:the\s+|each\s+a\s+|hereinafter\s+(?:called\s+|referred\s+to\s+as\s+)?(?:the\s+)?)?["“']?([A-Z][a-z]+)["”']?\s*\)`;
  const name = String.raw`((?:[A-Z][\w&.'’-]*|&|of|and)(?:,?\s+(?:[A-Z][\w&.'’-]*|&|of|and))*)`;
  // 'Harrow Example Ltd ("Provider")', 'Harrow Example Ltd, a Delaware corporation (the "Provider")'
  for (const re of [new RegExp(`${name}\\s*,?\\s*${label}`, "g"), new RegExp(`${name}\\s*,\\s*an?\\s+(?:[^()]|\\([^()]{0,60}\\)){3,160}?${label}`, "g")]) {
    for (const m of text.matchAll(re)) {
      const role = m[2].toLowerCase();
      const words = m[1].split(/\s+/);
      // drop a leading all-caps title ("CONSULTING AGREEMENT") or connective, unless the whole name is in capitals
      const allCaps = words.every((w) => !/[a-z]/.test(w));
      while (words.length > 1 && ((!allCaps && /^[A-Z]{2,}$/.test(words[0])) || /^(?:and|of|between|by|with)$/i.test(words[0]))) words.shift();
      if (ROLES.includes(role)) out.set(normalize(words.join(" ")).replace(/[,.]+$/, ""), role);
    }
  }
  return out;
}
function subjectRole(sentence: string, names: Map<string, string>): string | null {
  const s = normalize(sentence);
  const v = s.search(VERB);
  if (v < 0 || /\b(?:either|each|both|any|neither)\s+part/.test(s.slice(0, v))) return null;
  const head = s.slice(0, v);
  let best: { at: number; role: string } | null = null;
  for (const [name, role] of names) {
    const at = head.indexOf(name);
    if (at >= 0 && (!best || at < best.at)) best = { at, role };
  }
  const m = ROLE_RE.exec(head);
  if (m && (!best || m.index < best.at)) best = { at: m.index, role: m[1] };
  return best?.role ?? null;
}
/**
 * Clauses where the answer has one party do what the cited text has another party do ("the Provider pays" when
 * the agreement says the Client pays). Passive wording and "either party" aren't judged.
 */
export function roleSwaps(answer: string, support: string[], definitions: string): string[] {
  const names = partyRoles(definitions);
  const segs = support.flatMap(segments).map((t) => ({ t, a: [...anchors(t)].filter((w) => !isRate(w)), role: PASSIVE.test(normalize(t)) ? null : subjectRole(t, names) }));
  const out: string[] = [];
  for (const c of clauses(answer)) {
    if (PASSIVE.test(normalize(c))) continue;
    const role = subjectRole(c, names);
    if (!role) continue;
    const a = [...anchors(c)].filter((w) => !isRate(w));
    const about = segs.filter((s) => s.role && s.a.some((w) => a.includes(w)));
    if (about.length && !about.some((s) => s.role === role)) out.push(role);
  }
  return [...new Set(out)];
}

// ---- places, which models often write in lower case ----
const PLACES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia", "ontario", "quebec", "british columbia", "england", "scotland", "wales", "ireland", "canada", "mexico", "germany", "france", "spain", "italy", "netherlands", "switzerland", "singapore", "australia", "india", "japan", "china", "new zealand", "south africa", "hong kong", "united kingdom", "united states", "brazil", "sweden", "norway", "denmark", "belgium", "austria", "portugal", "poland", "israel", "korea", "taiwan", "cayman islands", "bermuda", "luxembourg"];
/** Place names in the answer (any case) that the cited text and the question don't contain. */
export function unsupportedPlaces(answer: string, support: string[], question: string): string[] {
  const a = normalize(answer);
  const hay = normalize(support.join(" \n ") + " \n " + question);
  return [...new Set(PLACES.filter((p) => new RegExp(`\\b${p}\\b`).test(a) && !new RegExp(`\\b${p}\\b`).test(hay)))];
}

// ---- calculations ----
export type Calculation = { expression: string; result: string };
/** Evaluates + - * / ( ) and "n%" (n/100) with a tiny parser. Returns null for anything else. */
export function evaluate(expr: string): number | null {
  const s = expr.replace(/[$£€,\s]/g, "").replace(/[×x]/g, "*").replace(/÷/g, "/");
  if (!/^[\d.+\-*/()%]{1,120}$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  function num(): number | null {
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    let v = Number(m[0]);
    if (peek() === "%") { i++; v /= 100; }
    return v;
  }
  function factor(): number | null {
    if (peek() === "-") { i++; const v = factor(); return v === null ? null : -v; }
    if (peek() === "(") { i++; const v = sum(); if (peek() !== ")") return null; i++; return v; }
    return num();
  }
  function product(): number | null {
    let v = factor();
    while (v !== null && (peek() === "*" || peek() === "/")) {
      const op = s[i++];
      const r = factor();
      if (r === null || (op === "/" && r === 0)) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function sum(): number | null {
    let v = product();
    while (v !== null && (peek() === "+" || peek() === "-")) {
      const op = s[i++];
      const r = product();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}

/** Calendar and unit constants a calculation may use without a quote (months in a year, days in a year, ...). */
/** Calendar constants, allowed only when the question or answer talks about that period. */
const CONSTANTS: [string, RegExp][] = [
  ["3", /\bquarter(?:s|ly)?\b/],
  ["4", /\bquarter(?:s|ly)?\b/],
  ["12", /\b(?:year|years|yearly|annual|annually|annum|12 months|twelve months)\b/],
  ["52", /\b(?:year|yearly|annual|annually|weeks?|weekly)\b/],
  ["365", /\b(?:year|yearly|annual|annually|days?|daily)\b/],
  ["7", /\b(?:weeks?|weekly)\b/],
  ["24", /\b(?:hours?|hourly|days?|daily)\b/],
  ["60", /\b(?:minutes?|hours?|hourly)\b/],
  ["30", /\b(?:pro[ -]?rat\w*|pro rata|per day|daily|prorated)\b/],
  ["31", /\b(?:pro[ -]?rat\w*|pro rata|per day|daily|prorated)\b/],
];
const OPERAND = /([$£€])?\s*(\d[\d,]*(?:\.\d+)?)\s*(%)?/g;
const NUMERIC_RESULT = /^\s*[$£€]?\s*-?\d[\d,]*(?:\.\d+)?\s*%?\s*$/;
/**
 * Re-does each calculation. Each operand must be a figure of the same kind from the cited text (a rate from a
 * stated percentage, a sum from a stated amount, never a clause number) about the question's topic, a figure from
 * the question, a calendar constant, or an earlier verified result. The result must be a plain number that matches.
 */
export function checkCalculations(calcs: Calculation[], support: string[], question: string, topic: string): { verified: Set<string>; failed: string[] } {
  const verified = new Set<string>();
  const failed: string[] = [];
  const segs = supportSegments(support);
  const q = valuesIn(question);
  const fromQuestion = new Set(q.map((v) => v.n));
  const topicAnchors = anchors(`${question} ${topic}`);
  // "cost", "fee", "pay" and "invoice" are one topic: the synonym groups retrieval uses
  const groupsOf = (t: string) => new Set(normalize(t).split(/[^\p{L}]+/u).map((w) => GROUP_OF.get(w)).filter((g) => g !== undefined));
  const topicGroups = groupsOf(`${question} ${topic}`);
  const onTopic = (s: Seg) => [...s.a].some((w) => topicAnchors.has(w)) || [...groupsOf(s.t)].some((g) => topicGroups.has(g));
  const fromAgreement = (n: string, kind: Kind | null) => {
    const withIt = segs.filter((s) => s.v.some((x) => x.n === n && (kind === null || x.kind === kind || x.kind === "plain")));
    return withIt.length > 0 && withIt.some(onTopic);
  };
  const talk = normalize(`${question} ${topic}`);
  const constant = (n: string) => CONSTANTS.some(([c, re]) => c === n && re.test(talk));
  // dividing by 100 turns a stated percentage into a fraction; it's allowed only with such a percentage
  const percents = new Set(segs.filter(onTopic).flatMap((s) => s.v.filter((x) => x.kind === "percent").map((x) => x.n)));
  for (const c of calcs.slice(0, 6)) {
    const value = evaluate(c.expression);
    const operands = [...c.expression.replace(/[×x÷]/g, " ").matchAll(OPERAND)].map((m) => ({ n: String(Number(m[2].replace(/,/g, ""))), kind: (m[1] ? "money" : m[3] ? "percent" : null) as Kind | null }));
    const hundredOk = operands.some((o) => o.n !== "100" && percents.has(o.n));
    const known = (o: { n: string; kind: Kind | null }) =>
      verified.has(o.n) ||
      fromQuestion.has(o.n) ||
      (o.kind === null && (constant(o.n) || (o.n === "100" && hundredOk) || (Number(o.n) < 1 && percents.has(String(+(Number(o.n) * 100).toFixed(6)))))) ||
      fromAgreement(o.n, o.kind === "percent" ? "percent" : o.kind);
    const stated = Number(c.result.replace(/[$£€,%\s]/g, ""));
    const bad = value === null || !operands.length || !operands.every(known) || !NUMERIC_RESULT.test(c.result) || !Number.isFinite(stated) || Math.abs(value - stated) > 0.005 + Math.abs(value) * 1e-9;
    if (bad) failed.push(`${c.expression} = ${c.result}`);
    else {
      for (const o of operands) verified.add(o.n);
      verified.add(String(Number(stated)));
      verified.add(String(Number(value.toFixed(2))));
      verified.add(String(Math.round(value)));
    }
  }
  return { verified, failed };
}

// ---- quotations inside the answer ----
/** Text the answer puts in quotation marks (three words or more) that isn't in the cited passages. */
export function misquoted(answer: string, support: string[]): string[] {
  const hay = normalize(support.join(" \n "));
  const out: string[] = [];
  for (const m of answer.slice(0, MAX_TEXT).matchAll(/["“]([^"“”]{8,300})["”]|(?:^|[\s(])['‘]([^'‘’]{8,300})['’](?=[\s.,;:)!?]|$)/g)) {
    m[1] = m[1] ?? m[2];
    const q = normalize(m[1]).replace(/[.,;:!?]+$/, "");
    if (q.split(" ").length >= 3 && !hay.includes(q)) out.push(`"${m[1].slice(0, 60)}"`);
  }
  return out;
}

/**
 * Figures in the question that set up a scenario ("if a $3,200 invoice is a month late", "on a $4,000 invoice"):
 * parameters the answer may use freely, unlike a figure the question asserts ("Is the notice period 30 days?").
 */
export function scenarioFigures(question: string): Set<string> {
  const q = normalize(question);
  const out = new Set<string>();
  const at = q.search(/\b(?:if|suppose|supposing|assuming|what if|in case|say)\b/);
  const parts = [at >= 0 ? q.slice(at) : "", ...[...q.matchAll(/\b(?:on|for|of|with)\s+(?:a|an)\s+[$£€]?\d[\d,.]*\s*(?:[a-z]+)?/g)].map((m) => m[0])];
  for (const part of parts) {
    for (const v of valuesIn(part)) out.add(v.n);
    if (/\b(?:a|an|one)\s+(?:hour|day|week|month|year)\b/.test(part)) out.add("1");
  }
  return out;
}

/**
 * Arithmetic stated in the prose rather than listed ("1.5% of $3,200, which is $48", "$3,200 x 12 = $38,400"),
 * so it's re-done like a listed calculation instead of being withheld as an unexplained figure.
 */
export function impliedCalculations(text: string): Calculation[] {
  const out: Calculation[] = [];
  const t = text.slice(0, MAX_TEXT);
  const NUM = String.raw`[$£€]?\s?(\d[\d,]*(?:\.\d+)?)`;
  const RESULT = String.raw`(?:is|=|equals|comes to|which is|that is|gives|making|,\s*or)`;
  const n = (x: string) => x.replace(/,/g, "");
  // "1.5% of $3,200 is $48", "1.5% of the $3,200 fee, or $48" (but not "5% of $2,000 or $50, whichever is greater")
  for (const m of t.matchAll(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*%\s+of\s+(?:(?:the|a|an|each|your|its)\s+)?(?:[a-z]+\s+){0,2}?${NUM}(?:\s+[a-z]+){0,2}?[^.;\d]{0,30}?\b${RESULT}\s+${NUM}(?![^.;]{0,40}\bwhichever\b)`, "gi")))
    out.push({ expression: `${n(m[2])} * ${m[1]}%`, result: n(m[3]) });
  // "$48 (1.5% of $3,200)"
  for (const m of t.matchAll(new RegExp(String.raw`${NUM}\s*\(\s*(\d+(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?${NUM}\s*\)`, "gi")))
    out.push({ expression: `${n(m[3])} * ${m[2]}%`, result: n(m[1]) });
  // "$3,200 x 12 = $38,400"
  for (const m of t.matchAll(new RegExp(String.raw`${NUM}\s*(?:x|×|\*|times)\s*(\d[\d,]*(?:\.\d+)?)(%?)\s*(?:=|is|equals|comes to|gives)\s+${NUM}`, "gi")))
    out.push({ expression: `${n(m[1])} * ${n(m[2])}${m[3]}`, result: n(m[4]) });
  // "$48 a month, or $576 a year"
  for (const m of t.matchAll(new RegExp(String.raw`${NUM}\s+(?:a|per|each)\s+month,?\s+(?:or|so|which is|i\.e\.)\s+(?:about\s+)?${NUM}\s+(?:a|per|each)\s+year`, "gi")))
    out.push({ expression: `${n(m[1])} * 12`, result: n(m[2]) });
  return out.slice(0, 6);
}
