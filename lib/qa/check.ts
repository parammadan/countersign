// Checks on an AI answer beyond "every figure appears in a cited passage":
//   - binding: a figure must belong to the term the answer attaches it to. "Late fees are 20 per month" is
//     rejected when the cited text says "invoices are due within 20 days" and "a late fee of 2% per month".
//   - absence: "the agreement doesn't specify a deadline" is a statement about the document, not a negated fact,
//     so it doesn't trip the negation check.
//   - calculations: arithmetic the model shows is re-done here, from numbers in the agreement or the question
//     only; a verified result may then appear in the answer.
// All of it is deterministic and bounded; none of it calls a model.
import { normalize } from "../understand/evidence";

const MAX_TEXT = 6000;

// ---- absence statements ----
const ABSENCE: RegExp[] = [
  /\b(?:agreement|contract|document|letter|it|clause|section|passage|text|terms?)\s+(?:does|do|did)\s*(?:n['’]?t|not)\s+(?:\w+\s+)?(?:specify|state|say|mention|set out|give|define|address|include|provide|cover|explain|indicate|identify|list|name|require|contain|allow for)\b/g,
  /\b(?:there is|there's|there are|with|has|have|gives?|sets?|states?|contains?)\s+no\s+(?:specific|exact|fixed|set|particular|stated|defined|clear|explicit|express|separate|numeric|numerical)\b/g,
  /\bno\s+(?:specific|exact|fixed|set|particular|stated|defined|explicit|numeric|numerical)\s+(?:figure|number|amount|date|deadline|period|time|timeframe|time frame|term|duration|limit|cap|rate|percentage|fee|sum|notice period)\b/g,
  /\b(?:is|are|was|were|isn't|aren't)?\s*not\s+(?:specified|stated|defined|set out|given|mentioned|addressed|explained|identified|quantified)\b/g,
  /\b(?:not|never)\s+(?:say|state|specify|mention)\b/g,
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
const UNIT_WORDS = /^(?:hours?|days?|weeks?|months?|years?|hourly|daily|weekly|monthly|yearly|annual|annually|percent|per|cent|dollars?|usd|business|calendar|working)$/;
const MONTHS = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/;
const NUMBER_WORDS = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)$/;
const ANCHOR_STOP = new Set(
  ("the and for with this that from into are was were will shall must may can could would should has have had " +
    "its their there then than which who whom what when where each any all per of to in on at by an as be is it " +
    "agreement contract document under within after before upon following total amount number such other same " +
    "also only both either between including include includes included about there here these those those " +
    "answer says states stated provides provided according based therefore because since so if not no").split(" "),
);
const IRREGULAR: Record<string, string> = { paid: "pay", owed: "owe", owing: "owe", due: "due", fees: "fee" };
function stemWord(w: string): string {
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
  const re = /([$£€])?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\)\s*)?(%|percent|per\s?cent|(?:(?:business|calendar|working)\s+)?(?:hours?|days?|weeks?|months?|years?))?/g;
  for (const m of s.matchAll(re)) {
    const raw = m[2].replace(/,/g, "");
    if (!raw || Number.isNaN(Number(raw))) continue;
    // a year in a date ("2027") or a day of month next to a month name is a date, checked elsewhere
    const before = s.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
    if (/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/.test(before) || /^\d{4}$/.test(raw) && !m[1] && !m[3]) continue;
    const kind: Kind = m[1] ? "money" : m[3] ? (/%|cent/.test(m[3]) ? "percent" : "duration") : "plain";
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

/**
 * Figures the answer attaches to a term the agreement gives a DIFFERENT figure of the same kind, while no cited
 * sentence links this figure to that term. Figures in `skip` (from the question, or verified calculations) and
 * figures whose term can't be judged (the answer's words appear in no cited sentence) are not reported.
 */
export function unboundValues(answer: string, support: string[], question = "", skip: Set<string> = new Set()): string[] {
  const segs: { t: string; a: Set<string>; v: Value[] }[] = [];
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
    for (const v of stated) {
      if (skip.has(v.n)) continue;
      const withValue = segs.filter((s) => s.v.some((x) => x.n === v.n && compatible(x.kind, v.kind)));
      if (withValue.some((s) => binding.some((w) => s.a.has(w)))) continue;
      // the answer's term has a different specific figure in the agreement: of the same kind (one number of days
      // for another), or of another kind when the wording matches strongly (a sum put where the days belong)
      const shared = (s: { a: Set<string> }) => [...a].filter((w) => s.a.has(w)).length;
      const conflicting = segs.filter((s) => {
        const k = shared(s);
        // a competing figure the answer also states in this clause explains the overlap; it isn't a swap
        return k > 0 && s.v.some((x) => x.n !== v.n && !statedHere.has(x.n) && x.kind !== "plain" && (x.kind === v.kind ? k >= 1 : k >= 2));
      });
      if (conflicting.length) out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
    }
  }
  return [...new Set(out)];
}

// ---- calculations ----
export type Calculation = { expression: string; result: string };
const NUM_TOKEN = /\d+(?:\.\d+)?/g;
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

/**
 * Re-does each calculation. Operands must be numbers from the agreement, the question or an earlier verified
 * result; the stated result must match (to the cent). Returns the verified results and what failed.
 */
export function checkCalculations(calcs: Calculation[], allowed: Set<string>): { verified: Set<string>; failed: string[] } {
  const verified = new Set<string>();
  const failed: string[] = [];
  for (const c of calcs.slice(0, 6)) {
    const operands = [...c.expression.replace(/,/g, "").matchAll(NUM_TOKEN)].map((m) => String(Number(m[0])));
    const value = evaluate(c.expression);
    const stated = Number((c.result.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/) ?? [""])[0]);
    const bad =
      value === null ||
      !operands.length ||
      operands.some((o) => !allowed.has(o) && !verified.has(o) && o !== "100") ||
      !Number.isFinite(stated) ||
      Math.abs(value - stated) > 0.005 + Math.abs(value) * 1e-9;
    if (bad) failed.push(`${c.expression} = ${c.result}`);
    else {
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
  for (const m of answer.slice(0, MAX_TEXT).matchAll(/["“]([^"“”]{8,300})["”]/g)) {
    const q = normalize(m[1]).replace(/[.,;:!?]+$/, "");
    if (q.split(" ").length >= 3 && !hay.includes(q)) out.push(`"${m[1].slice(0, 60)}"`);
  }
  return out;
}
