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
import { numbersInAll, stripClauses, stripRefs } from "./numbers";

const MAX_TEXT = 6000;

// ---- absence statements ----
const ABSENCE: RegExp[] = [
  /\b(?:agreement|contract|document|letter|it|clause|section|passage|text|terms?)\s+(?:does|do|did)\s*(?:n['’]?t|not)\s+(?:\w+\s+)?(?:specify|state|say|mention|set out|give|define|address|include|provide|cover|explain|indicate|identify|list|name|require|contain|allow for)\b/g,
  /\b(?:there is|there's|there are|with|has|have|gives?|sets?|states?|contains?)\s+no\s+(?:specific|exact|fixed|set|particular|stated|defined|clear|explicit|express|separate|numeric|numerical)\b/g,
  /\bno\s+(?:specific|exact|fixed|set|particular|stated|defined|explicit|numeric|numerical)\s+(?:figure|number|amount|date|deadline|period|time|timeframe|time frame|term|duration|limit|cap|rate|percentage|fee|sum|notice period)\b/g,
  /\b(?:is|are|was|were|isn't|aren't)?\s*not\s+(?:specified|stated|defined|set out|given|mentioned|addressed|explained|identified|quantified)\b/g,
  /\b(?:not|never)\s+(?:say|state|specify|mention)\b/g,
  /\bnothing\s+(?:in\s+(?:the|this|it)\s*(?:agreement|contract|document)?\s*)?(?:requires|says|states|specifies|mentions|addresses|prevents|covers|provides(?:\s+for)?|allows|sets)\b/g,
  // the subject left implicit: "...but doesn't define 'promptly'", "it doesn't give a day count"
  /\b(?:does|do|did)\s*(?:n['’]?t|not)\s+(?:\w+\s+)?(?:specify|state|say|mention|set|set out|give|define|address|include|provide|cover|explain|indicate|identify|list|name|contain|quantify|explain)\b/g,
  /\b(?:isn['’]?t|is not|aren['’]?t|are not)\s+(?:specified|stated|defined|set out|given|mentioned|addressed|explained|identified|quantified|covered)\b/g,
  /\bno\s+(?:clause|section|provision|term|mention|reference|definition|passage|part)\b/g,
  /\bno\s+\w+(?:\s+of\s+\w+)?\s+(?:is|are|was|were)\s+(?:stated|specified|given|set|mentioned|defined|named|listed)\b/g,
  /\b(?:says|states|provides|contains|includes|sets out|specifies)\s+nothing\b/g,
  // seen in real answers: "sets no dollar cap", "isn't named in the agreement", "doesn't support that", hedges
  /\b(?:sets?|has|have|contains?|includes?|gives?|states?|provides?|names?|lists?)\s+no\b/g,
  /\b(?:isn['’]?t|is not|aren['’]?t|are not)\s+(?:named|listed|included|mentioned|covered|addressed|among|part of|reflected|supported|found)\b/g,
  /\b(?:does|do|did)\s*(?:n['’]?t|not)\s+(?:support|appear|seem|come from|reflect|change|override|alter|affect|mean|make)\b/g,
  /\b(?:not|never)\s+(?:binding|enforceable as written|part of the (?:agreement|terms))\b/g,
];
/** The answer with statements about what the document doesn't say removed (for the negation check only). */
export function withoutAbsence(answer: string): string {
  let a = normalize(answer.slice(0, MAX_TEXT));
  // the phrase and what it says is missing ("doesn't state a number of days"), up to the next punctuation
  for (const re of ABSENCE) a = a.replace(new RegExp(`${re.source}(?:(?!\\s+but\\b)[^.;!?\\n])*`, "g"), " ");
  return a;
}

// ---- references to pages and clauses are labels, not figures ("page 2", "Clause 4.1", "sections 3 and 5") ----
export const stripPageRefs = (s: string) =>
  s.replace(/\b(?:pages?|clauses?|sections?|paragraphs?|articles?|schedules?|exhibits?|appendi(?:x|ces)|annex(?:es)?|§)\s*\(?\d{1,4}(?:\.\d{1,3})*[a-z]?\)?(?:\s*(?:,|and|&|-|–|to|or)\s*\(?\d{1,4}(?:\.\d{1,3})*[a-z]?\)?)*/gi, " ");

// ---- binding ----
export const ROLES = ["client", "clients", "provider", "consultant", "firm", "company", "customer", "supplier", "contractor", "vendor", "agency", "licensor", "licensee", "landlord", "tenant", "buyer", "seller", "employer", "employee", "party", "parties", "counterparty"];
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
  if (/^\s*\(?\d{1,3}(?:\.\d{1,3})*[.)]?\s*$/.test(text)) return [];
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
export function clauses(text: string): string[] {
  // "and" splits two claims, not a range of numbers ("Lease Years 3 and 4")
  return stripPageRefs(text.slice(0, MAX_TEXT)).split(/(?<=[.!?])\s+|;\s*|\n+|,?\s+(?:and|but|while|whereas|plus)\s+(?!\d)|,\s+(?:so|therefore|thus|which means|meaning|hence)\s+|\s+(?:so|therefore|thus|hence)\s+(?!that\b|on\b|as\b|long\b|far\b|much\b|many\b|forth\b)/i).map((s) => s.trim()).filter(Boolean);
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
      // the same period said another way: "fortnightly" is 2 weeks, "48 hours" is 2 days
      const n = normalize(t);
      if (/\b(?:fortnight\w*|bi-?weekly|every other week)\b/.test(n)) v.push({ n: "2", kind: "duration" }, { n: "14", kind: "duration" });
      for (const m of n.matchAll(/\b(\d+)\s*(?:-\s*)?hours?\b/g)) if (+m[1] > 0 && +m[1] % 24 === 0) v.push({ n: String(+m[1] / 24), kind: "duration" });
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
export function unboundValues(answer: string, support: string[], question = "", skip: Set<string> = new Set(), fromQuestion: Set<string> = new Set(), scenario: Set<string> = new Set(), agreement: string[] = [], cited: string[] = support): string[] {
  const citedSegs = supportSegments(cited);
  // word overlap counting synonyms ("capped" ~ "limited", "invoice" ~ "payment") as matches
  const groupTags = (t: string) => new Set(normalize(t).split(/[^\p{L}]+/u).map((w) => GROUP_OF.get(w)).filter((g): g is number => g !== undefined));
  const closeness = (clauseAnchors: Set<string>, clauseGroups: Set<number>, s: Seg) => [...clauseAnchors].filter((w) => !isRate(w) && s.a.has(w)).length + [...groupTags(s.t)].filter((g) => clauseGroups.has(g)).length;
  const segs = supportSegments(support);
  // where a figure belongs is looked up in the whole agreement (a calculation input from another clause), conflicts
  // only in the text the answer cites
  const home = agreement.length ? supportSegments([...support, ...agreement]) : segs;
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
    // comparing the user's figure with the agreement's ("45 days falls in the 89-to-30-day window", "200 hours is
    // fewer than 520") is evaluating their scenario, not stating a term
    const compares = /\b(?:falls?\s+(?:in|within|inside|outside|before|after|under)|is\s+(?:fewer|less|more|greater|longer|shorter|lower|higher)\s+than|exceeds?|is\s+(?:within|inside|outside|below|above|under|over)|comes\s+(?:before|after))\b/i.test(c);
    const conditional = compares || /\b(?:if|assuming|suppos\w*|on an?|in that case|in your example|in this scenario|because|since|given(?: that)?|when|once)\b/i.test(c);
    for (const v of stated) {
      // "5% of $1,000" applies a stated rate to the user's own figure
      if (skip.has(v.n)) continue;
      // "4% of $1,500,000": a stated rate applied to the user's own figure
      if (scenario.has(v.n) && /%\s+of\b/.test(c)) continue;
      if (scenario.has(v.n) && conditional) {
        // "if you give 30 days' written notice, either party may terminate" against "may terminate on 45 days'
        // written notice": a figure the user supposes for a term the agreement fixes differently is still checked
        const own = [...anchors(c)].filter((w) => !isRate(w));
        // a supposed period or rate attached to the same thing the agreement's own figure is ("30 days' notice"
        // against "45 days' written notice"), or sharing two words with that clause
        const after = headsAfter(c, v.n);
        const strong = segs.some((sg) => sg.v.some((x) => x.kind === v.kind && x.kind !== "plain" && x.n !== v.n && !statedHere.has(x.n) && (own.filter((w) => sg.a.has(w)).length >= 2 || (v.kind !== "money" && [...headsAfter(sg.t, x.n)].some((w) => after.has(w))))));
        if (compares) {
          // the comparison must be true: 30 days after invoice isn't within 15-day payment terms
          if (comparisonHolds(c, v.n, segs.map((x) => x.t)) === false) out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
          continue;
        }
        if (!strong) continue;
        out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
        continue;
      }
      const withValue = home.filter((s) => s.v.some((x) => x.n === v.n && compatible(x.kind, v.kind)));
      const bound = withValue.filter((s) => binding.some((w) => s.a.has(w)));
      if (bound.length) {
        // a figure found only outside the cited clauses ("$1,000,000" from the insurance clause, for a question about
        // the liability cap) belongs to the answer's term only if its clause is at least as close to the answer as
        // the cited clauses are
        const same = (x: string, y: string) => normalize(x).includes(normalize(y)) || normalize(y).includes(normalize(x));
        const fromCited = bound.some((s) => citedSegs.some((x) => same(x.t, s.t)));
        if (fromCited) continue;
        // words in a contrast ("shares of the price, not termination payments") don't say what the figure is about
        const positive = c.replace(/\b(?:not|no|never|rather than|instead of)\b[^,.;:]*/gi, " ");
        const pa = anchors(positive);
        const cg = groupTags(positive);
        const bestBound = Math.max(...bound.map((s) => closeness(pa, cg, s)));
        // a cited clause whose figure the sentence also states ("…of the $184,000 fixed price") explains its own overlap
        const bestCited = Math.max(0, ...citedSegs.filter((s) => s.v.some((x) => x.kind !== "plain" && x.n !== v.n && !statedHere.has(x.n))).map((s) => closeness(pa, cg, s)));
        // and the answer must name what that clause is about that the cited clauses aren't ("insurance"), not only
        // a word they share ("liability")
        const citedWords = new Set(citedSegs.flatMap((s) => [...s.a]));
        const distinctive = bound.some((s) => [...s.a].some((w) => !isRate(w) && !citedWords.has(w) && pa.has(w)));
        // "In practice that cap is the $1,000,000 insurance": tying a cited clause's term to a figure from another
        // clause, without saying they're separate ("separately", "only", "not"), equates them
        const separate = /\b(?:separately|also|additionally|in addition|distinct|unlike|whereas|only|not|rather than|instead|by contrast|apart from|besides|independently|another|other)\b/i.test(c);
        // (a sentence that also states the cited clause's own figure, "$610 per hour, with time recorded in
        // 0.1-hour increments", is about both)
        const statesCited = citedSegs.some((sg) => sg.v.some((x) => x.kind !== "plain" && x.n !== v.n && statedHere.has(x.n)));
        if (bestBound >= bestCited && distinctive && (bestCited === 0 || separate || statesCited)) continue;
        out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
        continue;
      }
      // a figure that isn't in any sentence the model quoted, and that the answer doesn't tie to the clause it's
      // from, is a figure from elsewhere put to an unstated use ("so the most you could recover is $1,000,000")
      if (agreement.length && v.kind !== "plain" && withValue.length && !withValue.some((s) => citedSegs.some((x) => normalize(x.t).includes(normalize(s.t)) || normalize(s.t).includes(normalize(x.t))))) {
        out.push(`${v.n}${v.kind === "percent" ? "%" : ""}`);
        continue;
      }
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
// "isn't waived", "is not free": saying a charge applies
const AFFIRMING_NEGATION = /\b(?:not|isn['’]?t|is not|aren['’]?t|are not|never)\s+(?:waived|free|excused|forgiven)\b/g;
// limits and conditions, not reversals: "no later than", "not without notice", "can't end it sooner", "not a convenience
// termination" (a contrast), "not the same as"
const BOUNDS = /\b(?:no|not)\s+(?:later|earlier|more|less|fewer|sooner)\s+than\b|\b(?:not|cannot|\w+n['’]t)\b[^.,;]{0,50}?\b(?:without|sooner|earlier|before|until|unless|except|beyond)\b|(?<!there(?:'s| is| are| was)\s)\bnot\s+(?:a|an)\s+(?![a-z]*\s*(?:cap|limit|fee|charge|penalty|right|obligation)\b)|\bnot\s+(?:the same|the time|about)\b|\bnot\s+limited\s+by\s+(?:section|clause|article|paragraph|schedule)\b|\bnot\s+(?:cured|remedied|corrected|paid|received|delivered|disputed|approved|accepted)\s+(?:within|by|on|in)\b|\b(?:rather than|instead of)\b[^,.;:]*|,\s*(?:and\s+|but\s+)?not\s+(?:to|for|on|in|as|by|at|from|with)\b[^,.;:]*/g;
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
    // the cited sentences about the same thing: the best match, and any other that shares at least two words
    // (one shared generic word, like "pay" between "late payment interest" and "fees paid are not refundable", isn't
    // support; without a sentence sharing two words, a negation is unsupported)
    const near = best >= 2 ? segs.filter((s) => overlap(s) >= 2) : [];
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
/** The parties a text mentions, as roles: by role word ("the Client") or by defined name ("Quill Sample Inc"). */
export function partiesIn(text: string, names: Map<string, string>): Set<string> {
  const t = normalize(text);
  const out = new Set<string>();
  for (const [name, role] of names) if (name && t.includes(name)) out.add(role);
  for (const m of t.matchAll(new RegExp(`\\b(${ROLES.filter((r) => !/part/.test(r)).join("|")})\\b`, "g"))) out.add(m[1].replace(/s$/, ""));
  return out;
}
/**
 * Clauses where the answer has one party do what the cited text has another party do ("the Provider pays" when
 * the agreement says the Client pays). Passive wording and "either party" aren't judged.
 */
export function roleSwaps(answer: string, support: string[], definitions: string): string[] {
  const names = partyRoles(definitions);
  // each clause of the cited text has its own subject ("...the Licensee shall pay only the shortfall and the
  // Licensor shall bear the costs of the audit"); a clause without one keeps the sentence's ("The Tenant shall keep
  // the Property clean and promptly report any needed repairs")
  const segs = support.flatMap(segments).flatMap((sentence) => {
    let carried: string | null = null;
    return clauses(sentence).map((t) => {
      const passive = PASSIVE.test(normalize(t));
      const own = passive ? null : subjectRole(t, names);
      const role = passive ? null : (own ?? (ROLE_RE.test(normalize(t)) ? null : carried));
      if (own) carried = own;
      return { t, a: [...anchors(t)].filter((w) => !isRate(w)), role };
    });
  });
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
/**
 * Evaluates + - * / ( ), "n%" (n/100) and min(...), max(...), round(x[, digits]) with a tiny parser. Thousands
 * separators ("1,500,000") are read as such; a comma followed by a space separates arguments. Null for anything else.
 */
/** "26 weeks * 7" is "26 * 7": one unit, each time right after a number, and no other words; otherwise unchanged. */
function dropUnit(expr: string): string {
  const UNIT = /(?<=\d\s*)(days?|weeks?|months?|years?|hours?|minutes?|units?|items?|bottles?|users?|seats?|licen[cs]es?|pieces?|tins?|shifts?)\b/gi;
  const words = expr.toLowerCase().match(/\b(?!(?:min|max|round|x)\b)[a-z][a-z'’-]*\b/g) ?? [];
  const units = [...expr.matchAll(UNIT)].map((m) => m[1].toLowerCase().replace(/s$/, ""));
  if (!words.length || units.length !== words.length || new Set(units).size !== 1) return expr;
  return expr.replace(UNIT, "");
}
export function evaluate(expr: string): number | null {
  const s = dropUnit(expr)
    .toLowerCase()
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
    .replace(/[$£€\s]/g, "")
    .replace(/[×]/g, "*")
    .replace(/(?<=[\d)])x(?=[\d(])/g, "*")
    .replace(/÷/g, "/");
  if (!/^(?:[\d.+\-*/()%,]|min|max|round){1,200}$/.test(s)) return null;
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
  function call(): number | null {
    const m = /^(min|max|round)\(/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    const args: number[] = [];
    for (;;) {
      const v = sum();
      if (v === null) return null;
      args.push(v);
      if (peek() === ",") { i++; continue; }
      if (peek() === ")") { i++; break; }
      return null;
    }
    if (m[1] === "min") return Math.min(...args);
    if (m[1] === "max") return Math.max(...args);
    const d = args[1] ?? 0;
    return args.length <= 2 && Number.isInteger(d) && d >= 0 && d <= 6 ? Math.round(args[0] * 10 ** d) / 10 ** d : null;
  }
  function factor(): number | null {
    if (peek() === "-") { i++; const v = factor(); return v === null ? null : -v; }
    if (peek() === "(") { i++; const v = sum(); if (peek() !== ")") return null; i++; return v; }
    if (/[mr]/.test(peek() ?? "")) return call();
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

/** Calendar constants, allowed only when the question or answer talks about that period. */
const CONSTANTS: [string, RegExp][] = [
  ["2", /\b(?:two weeks|fortnight\w*|bi-?weekly|twice|every other)\b/],
  ["0.5", /\bhalf\b/],
  ["3", /\bquarter(?:s|ly)?\b|\bthree months\b/],
  ["4", /\bquarter(?:s|ly)?\b/],
  ["12", /\b(?:year|years|yearly|annual|annually|annum|12 months|twelve months)\b/],
  ["52", /\b(?:year|yearly|annual|annually|weeks?|weekly)\b/],
  ["26", /\b(?:fortnight\w*|bi-?weekly|year|annual\w*)\b/],
  ["365", /\b(?:year|yearly|annual|annually|days?|daily)\b/],
  ["7", /\b(?:weeks?|weekly)\b/],
  ["24", /\b(?:hours?|hourly|days?|daily)\b/],
  ["60", /\b(?:minutes?|hours?|hourly)\b/],
  ["30", /\b(?:pro[ -]?rat\w*|pro rata|per day|daily|prorated)\b/],
  ["31", /\b(?:pro[ -]?rat\w*|pro rata|per day|daily|prorated)\b/],
];
const OPERAND = /([$£€])?\s*(\d[\d,]*(?:\.\d+)?)\s*(%)?/g;
/** The result: a number first, optionally with a currency sign, a percent sign and a short label after it. */
const RESULT = /^\s*[$£€]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*%?([\s\S]*)$/;
export type CalcCheck = {
  verified: Set<string>;
  operands: Set<string>;
  fromAgreement: Set<string>;
  /** every calculation that didn't check out: `wrong` plus `unproven` */
  failed: string[];
  /** always withheld: the arithmetic is wrong or can't be parsed */
  wrong: string[];
  /** the arithmetic is right but an input's origin isn't confirmed (unknown, from an unrelated clause), or its label adds figures */
  unproven: string[];
  qualified: string[];
  /** the dates of date steps that checked out, as written (base and result): reasoning, not invented */
  dates: string[];
  /**
   * figures re-done here whatever the topic: results (and their inputs) of steps whose arithmetic checks out and whose
   * inputs are each stated somewhere in the binding agreement, in the question, an earlier such result or a calendar
   * constant. Which term an input belongs to is left to the verifier.
   */
  recomputed: Set<string>;
};
/**
 * Re-does each calculation. It's FAILED (the answer is withheld) when the arithmetic is wrong or an input is a figure
 * that isn't in the agreement, the question, an earlier result or a calendar constant for a period the answer talks
 * about. Rates must be percentages the agreement states (or derived from one: 1.2 for a 20% markup, 0.015 for 1.5%,
 * 1.5 or 2 for overtime the agreement mentions). It's QUALIFIED (shown with a note) when every input is real but one
 * comes from a part of the agreement that isn't about the question, or the result's label has figures that aren't
 * checked.
 */
// ---- dates and comparisons in calculations ----
const MONTHS_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (m: string) => MONTHS_FULL.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
const MONTH_NAME = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?";
/** A calendar date written as "2 September 2025", "September 2, 2025" or "2025-09-02", as UTC midnight; null if none. */
export function parseDate(t: string): Date | null {
  const s = t.trim();
  let m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME},?\\s+(\\d{4})`, "i").exec(s);
  if (m) return mk(Number(m[3]), monthIndex(m[2]), Number(m[1]));
  m = new RegExp(`^${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i").exec(s);
  if (m) return mk(Number(m[3]), monthIndex(m[1]), Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return mk(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}
function mk(y: number, mo: number, d: number): Date | null {
  if (mo < 0 || d < 1 || d > 31) return null;
  const x = new Date(Date.UTC(y, mo, d));
  return x.getUTCMonth() === mo ? x : null;
}
const DATE_TERM = new RegExp(`(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME},?\\s+\\d{4}|${MONTH_NAME}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`, "i");
/**
 * "2 September 2025 + 45 days" = "17 October 2025" (also weeks, months, years, and "-"): true when right, false when
 * wrong, null when the expression isn't a date step. Months and years keep the day, clamped to the month's length.
 */
export function checkDateStep(expression: string, result: string): { ok: boolean; dates: string[]; count: string } | null {
  // "28 February 2029 − six months": any minus or dash, and a count in words
  const COUNT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  expression = expression.replace(/[−–—]/g, "-").replace(new RegExp(`\\b(${COUNT.join("|")})\\b(?=\\s*(?:\\(\\d+\\)\\s*)?(?:calendar\\s+)?(?:days?|weeks?|months?|years?)\\b)`, "gi"), (w) => String(COUNT.indexOf(w.toLowerCase()))).replace(/(\d+)\s*\(\1\)/g, "$1");
  const m = new RegExp(`^\\s*${DATE_TERM.source}\\s*([+-])\\s*(\\d+)\\s*(?:calendar\\s+)?(days?|weeks?|months?|years?)\\s*$`, "i").exec(expression);
  if (!m) return null;
  const base = parseDate(m[1]);
  const got = parseDate((DATE_TERM.exec(result) ?? [""])[0]);
  if (!base || !got) return null;
  const sign = m[m.length - 3] === "-" ? -1 : 1;
  const n = Number(m[m.length - 2]) * sign;
  const unit = m[m.length - 1].toLowerCase();
  const d = new Date(base.getTime());
  if (unit.startsWith("day")) d.setUTCDate(d.getUTCDate() + n);
  else if (unit.startsWith("week")) d.setUTCDate(d.getUTCDate() + 7 * n);
  else {
    const months = unit.startsWith("month") ? n : 12 * n;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return { ok: d.getTime() === got.getTime(), dates: [m[1], (DATE_TERM.exec(result) ?? [""])[0]], count: String(Math.abs(n)) };
}
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";
const DATE_TERM_G = new RegExp(DATE_TERM.source, "gi");
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Every calendar date written in a text, as yyyy-mm-dd. */
export function datesIn(text: string, limit = MAX_TEXT): Set<string> {
  const out = new Set<string>();
  for (const m of text.slice(0, limit).matchAll(DATE_TERM_G)) {
    const d = parseDate(m[0]);
    if (d) out.add(iso(d));
  }
  return out;
}
/** A step's notes ("(second anniversary)", "(discount forgone)") aren't part of it: parentheses holding words are dropped. */
export const stripNotes = (t: string) => t.replace(/[−–—]/g, "-").replace(/\s*\((?=[^)]*\p{L}{2})[^()]*\)/gu, " ").replace(/\s+/g, " ").trim();
/**
 * "Next Working Day after <date>": what counts as a working day is the agreement's definition (holidays, days banks
 * are closed, the parties' own closures), which can't be confirmed without reading it, so a roll is never re-done here
 * and its result gets no provenance; the verifier judges it. Only a step where nothing moves ("next working day after
 * Tuesday 31 December 2024" = "31 December 2024") is checked: a date that does move is unproven. Null when the
 * expression isn't such a step.
 */
export function checkNextWorkingDay(expression: string, result: string): { ok: boolean; dates: string[] } | null {
  const m = new RegExp(`^\\s*(?:the\\s+)?next\\s+(?:working|business)\\s+day\\s+(?:after|following)\\s+(?:${WEEKDAY},?\\s+)?(${DATE_TERM.source})(.*)$`, "i").exec(expression);
  if (!m) return null;
  const base = parseDate(m[2]);
  const got = parseDate((DATE_TERM.exec(result) ?? [""])[0]);
  if (!base || !got) return null;
  // a weekday the date stays on is checked; a moved date (weekend, holiday, closure) isn't re-done here
  if (base.getUTCDay() === 0 || base.getUTCDay() === 6 || got.getTime() !== base.getTime()) return null;
  return { ok: true, dates: [m[2], (DATE_TERM.exec(result) ?? [""])[0]] };
}
/**
 * "January 2026 + 2 calendar months, on the 10th day" = "March 10, 2026": a month-and-year base moved by whole months,
 * then a stated day of that month. Null when not such a step. The base month needs provenance (a known date in it),
 * as do the count and the day.
 */
export function checkMonthDayStep(expression: string, result: string): { ok: boolean; month: { y: number; m: number }; count: string; day: string; dates: string[] } | null {
  const m = new RegExp(`^\\s*${MONTH_NAME}\\s+(\\d{4})\\s*([+-])\\s*(\\d+)\\s*(?:calendar\\s+)?months?,?\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+day(?:\\s+of\\s+(?:that|the)\\s+month)?\\s*$`, "i").exec(expression);
  if (!m) return null;
  const got = parseDate((DATE_TERM.exec(result) ?? [""])[0]);
  const mo = monthIndex(m[1]);
  if (!got || mo < 0) return null;
  const y = Number(m[2]);
  const n = Number(m[4]) * (m[3] === "-" ? -1 : 1);
  const day = Number(m[5]);
  const first = new Date(Date.UTC(y, mo + n, 1));
  const want = mk(first.getUTCFullYear(), first.getUTCMonth(), day);
  return { ok: !!want && want.getTime() === got.getTime(), month: { y, m: mo }, count: String(Math.abs(n)), day: String(day), dates: [(DATE_TERM.exec(result) ?? [""])[0]] };
}
/** Western (Gregorian) Easter Sunday for a year, as UTC midnight (anonymous Gregorian algorithm). */
export function easterSunday(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31) - 1, day = ((h + l - 7 * mm + 114) % 31) + 1;
  return new Date(Date.UTC(y, month, day));
}
// holidays whose date follows from the year alone; anything else must be dated by the agreement itself
const COMPUTED_HOLIDAYS: [RegExp, (y: number) => Date][] = [
  [/^new year'?s day$/i, (y) => new Date(Date.UTC(y, 0, 1))],
  [/^good friday$/i, (y) => new Date(easterSunday(y).getTime() - 2 * 86400000)],
  [/^easter monday$/i, (y) => new Date(easterSunday(y).getTime() + 86400000)],
  [/^christmas day$/i, (y) => new Date(Date.UTC(y, 11, 25))],
  [/^boxing day$/i, (y) => new Date(Date.UTC(y, 11, 26))],
];
// month names in either case, for scans that also need capitalised names (which must stay case-sensitive)
const ci = (src: string) => src.replace(/(?<![\\[])\b([a-z])/g, (c) => `[${c.toUpperCase()}${c}]`);
const MONTH_NAME_CI = ci(MONTH_NAME);
const DATE_TERM_CI = DATE_TERM.source.split(MONTH_NAME).join(MONTH_NAME_CI);
/**
 * Holiday lists in an agreement: a "public holidays" / "bank holidays" heading that states a year ("Public holidays
 * (2026)", "Public Holidays 2026:", "bank holidays for 2027"), and the "<Name> <day> <month>" entries that follow it up
 * to the next clause number or heading. A list without a year dates nothing.
 */
function holidayLists(text: string): { year: number; entries: Map<string, string> }[] {
  const heads = [...text.matchAll(/\b(?:public|bank)\s+holidays?\b(?:\s+(?:for|in))?\s*\(?\s*((?:19|20)\d{2})?\s*\)?\s*:?/gi)];
  const out: { year: number; entries: Map<string, string> }[] = [];
  heads.forEach((h, i) => {
    if (!h[1]) return;
    const from = h.index! + h[0].length;
    const nextHead = i + 1 < heads.length ? heads[i + 1].index! : text.length;
    // the list ends at the next heading, the next clause number ("7.1 ") or "Schedule"/"Annex", or 800 characters on
    const stop = /\s(?:\d+(?:\.\d+)+\s|Schedule\s|Annex\s|Appendix\s)/.exec(text.slice(from));
    const to = Math.min(nextHead, stop ? from + stop.index : text.length, from + 800);
    const year = Number(h[1]);
    const entries = new Map<string, string>();
    for (const e of text.slice(from, to).matchAll(new RegExp(`([A-Z][A-Za-z']*(?:\\s+[A-Z][A-Za-z']*){0,3})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME_CI}(?!\\s*,?\\s*\\d{4})`, "g"))) {
      const d = mk(year, monthIndex(e[3]), Number(e[2]));
      if (d) entries.set(iso(d), e[1].trim().toLowerCase());
    }
    if (entries.size) out.push({ year, entries });
  });
  return out;
}
/**
 * "Next Working Day after Sunday 5 April 2026, skipping Easter Monday 6 April 2026" = "Tuesday 7 April 2026": a roll
 * past weekends and named public holidays, re-done only when every holiday can be dated from the agreement for that
 * year. Dated: from a holiday list whose stated year is the base date's year (each entry with its list's year). Undated:
 * the holiday is named in the working/business-day definition itself and its date follows from the year (Western
 * Easter; never with an Orthodox calendar). Each named holiday falls inside the roll, every day skipped is a weekend or
 * a named holiday, and no holiday (named in the step or not) may be skipped silently or be the result. Null when not
 * such a step or when a holiday can't be dated this way (the verifier then judges it, as before).
 */
export function checkHolidayRoll(expression: string, result: string, agreement: string): { ok: boolean; dates: string[] } | null {
  const m = new RegExp(`^\\s*(?:the\\s+)?next\\s+(?:working|business)\\s+day\\s+(?:after|following)\\s+(?:${WEEKDAY},?\\s+)?(${DATE_TERM.source}),?\\s+(?:skipping|excluding|after|past)\\s+(.+)$`, "i").exec(expression);
  if (!m) return null;
  const base = parseDate(m[2]);
  const gotText = (DATE_TERM.exec(result) ?? [""])[0];
  const got = parseDate(gotText);
  if (!base || !got || got.getTime() <= base.getTime()) return null;
  const year = base.getUTCFullYear();
  const text = agreement.replace(/\s+/g, " ");
  if (/\borthodox\b/i.test(text)) return null;
  const lists = holidayLists(text);
  const forYear = lists.filter((l) => l.year === year);
  // the holidays that can't be working days this year, by date
  const holidays = new Map<string, string>();
  if (lists.length) {
    // dated lists exist: only one for this year can date a holiday
    if (!forYear.length) return null;
    for (const l of forYear) for (const [k, v] of l.entries) holidays.set(k, v);
  } else {
    const def = /["“](?:working|business)\s+days?["”][^.]{0,400}/i.exec(text)?.[0];
    if (!def) return null;
    for (const [re, at] of COMPUTED_HOLIDAYS) {
      const name = re.source.replace(/^\^|\$$/g, "").replace(/'\?/g, "'?");
      if (new RegExp(`\\b${name}\\b`, "i").test(def)) for (const y of [year, year + 1]) holidays.set(iso(at(y)), name.replace(/'\?/g, "'").toLowerCase());
    }
  }
  // the holidays the step names, each with its date
  const named = [...m[m.length - 1].matchAll(new RegExp(`([A-Z][A-Za-z']*(?:\\s+[A-Z][A-Za-z']*){0,3})\\s*\\(?\\s*(${DATE_TERM_CI})`, "g"))];
  if (!named.length) return null;
  const skipped = new Set<string>();
  const out: string[] = [m[2]];
  for (const h of named) {
    const d = parseDate(h[2]);
    if (!d) return null;
    const k = iso(d);
    const name = h[1].trim().toLowerCase().replace(/[’]/g, "'");
    const listedName = holidays.get(k)?.replace(/'\?/g, "'");
    // undated mode only knows the holidays the definition names; an unknown name isn't re-done here
    if (!lists.length && !COMPUTED_HOLIDAYS.some(([re]) => re.test(h[1].trim()))) return null;
    // the date must be that holiday's, and inside the roll
    if (listedName !== name || d.getTime() <= base.getTime() || d.getTime() > got.getTime()) return { ok: false, dates: [] };
    skipped.add(k);
    out.push(h[2]);
  }
  // walk from the day after the base: weekends and named holidays are skipped; the first other day is the answer
  const d = new Date(base.getTime() + 86400000);
  for (let i = 0; i < 14; i++, d.setUTCDate(d.getUTCDate() + 1)) {
    const k = iso(d);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (weekend || skipped.has(k)) continue;
    // a holiday the step didn't name can't be the next working day
    if (holidays.has(k)) return { ok: false, dates: [] };
    return { ok: k === iso(got), dates: [...out, gotText] };
  }
  return null;
}
/**
 * "420 < 500, so commission = 0" = "€0": a zero that follows from a threshold. True when the comparison holds and the
 * result is zero, false when the comparison is false or the result isn't zero, null when not such a step. Both
 * figures need provenance and the threshold must be one the agreement states.
 */
export function checkThresholdZero(expression: string, result: string): { ok: boolean; a: string; b: string } | null {
  const m = /^\s*([$£€]?\s*\d[\d,]*(?:\.\d+)?)\s*(<=|>=|<|>|≤|≥)\s*([$£€]?\s*\d[\d,]*(?:\.\d+)?)\s*,?\s*(?:so|therefore|thus|hence)\s+[\p{L}\s'-]{1,40}?\s*=\s*([$£€]?\s*0(?:\.0+)?)\s*$/iu.exec(expression);
  if (!m) return null;
  const num = (x: string) => Number(x.replace(/[$£€\s,]/g, ""));
  const a = num(m[1]), b = num(m[3]);
  const truth = m[2] === "<" ? a < b : m[2] === ">" ? a > b : m[2] === "<=" || m[2] === "≤" ? a <= b : a >= b;
  const zero = /^\s*[$£€]?\s*0(?:\.0+)?\s*(?:\(|$|[a-z])/i.test(result);
  return { ok: truth && zero, a: String(a), b: String(b) };
}
const CLOCK = `${WEEKDAY}\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?`;
const minutesOf = (day: string, h: string, mi: string | undefined, ap: string | undefined) => {
  let hh = Number(h) % (ap ? 12 : 24);
  if (ap && /^p/i.test(ap)) hh += 12;
  return WEEKDAYS.indexOf(day.toLowerCase()) * 1440 + hh * 60 + Number(mi ?? 0);
};
/** "Monday 6:30 a.m. + 72 hours" = "Thursday 6:30 a.m.": weekday-and-clock arithmetic. Null when not such a step. */
export function checkClockStep(expression: string, result: string): { ok: boolean; count: string; text: string[] } | null {
  const m = new RegExp(`^\\s*${CLOCK}\\s*([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(?:working\\s+|business\\s+)?(hours?|minutes?)\\s*$`, "i").exec(expression);
  const r = new RegExp(`^\\s*${CLOCK}`, "i").exec(result);
  if (!m || !r) return null;
  const n = Number(m[6]) * (m[7].toLowerCase().startsWith("hour") ? 60 : 1) * (m[5] === "-" ? -1 : 1);
  // "working hours" are only re-done when they stay within one day (a working-day calendar isn't known here)
  if (/working|business/i.test(expression) && r[1].toLowerCase() !== m[1].toLowerCase()) return null;
  const want = (((minutesOf(m[1], m[2], m[3], m[4]) + n) % 10080) + 10080) % 10080;
  return { ok: want === minutesOf(r[1], r[2], r[3], r[4]), count: String(Number(m[6])), text: [m[0].split(/\s*[+-]\s*\d/)[0].trim(), r[0].trim()] };
}
/**
 * "March 1, 2027 to June 30, 2027" = "4 whole calendar months" (or N days/weeks): the span between two dates. Months
 * count whole calendar months from a first day to a last day; days may be counted either way (with or without the
 * end day). Null when not such a step.
 */
export function checkSpan(expression: string, result: string): { ok: boolean; dates: string[]; count: string } | null {
  const m = new RegExp(`^\\s*(?:from\\s+)?(${DATE_TERM.source})\\s+(?:to|until|through|-)\\s+(${DATE_TERM.source})\\s*$`, "i").exec(expression);
  const r = /^\s*(\d+(?:\.\d+)?)\s*(?:whole\s+|full\s+|complete\s+)?(?:calendar\s+)?(days?|weeks?|months?)\b/i.exec(result);
  if (!m || !r) return null;
  const both = [...expression.matchAll(DATE_TERM_G)].map((x) => x[0]);
  if (both.length !== 2) return null;
  const a = parseDate(both[0]);
  const b = parseDate(both[1]);
  if (!a || !b) return null;
  const inclusive = /\binclusive\b/i.test(`${expression} ${result}`);
  const n = Number(r[1]);
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  let ok: boolean;
  if (/^month/i.test(r[2])) {
    const lastDay = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate() === b.getUTCDate();
    ok = a.getUTCDate() === 1 && lastDay && (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1 === n;
  } else if (/^week/i.test(r[2])) ok = (inclusive ? days + 1 : days) === 7 * n;
  else ok = (inclusive ? days + 1 : days) === n;
  const texts = [...expression.matchAll(DATE_TERM_G)].map((x) => x[0]);
  return { ok, dates: texts, count: String(n) };
}
/**
 * Weekdays written next to a date ("Sunday 5 April 2026", "5 April 2026 (Sunday)", "February 10, 2029, a Saturday"):
 * the ones that match their date, and the ones that don't.
 */
/** The text with every date (in any format) that falls on one of the given dates replaced by a space. */
export function withoutDates(text: string, dates: string[]): string {
  const keys = new Set(dates.map((d) => parseDate(d)).filter((d): d is Date => d !== null).map(iso));
  if (!keys.size) return text;
  return text.replace(DATE_TERM_G, (m) => {
    const d = parseDate(m);
    return d && keys.has(iso(d)) ? " " : m;
  });
}
/**
 * Dates in an answer that put a day and month the agreement states without a year ("Quarter Days: 25 March, 24 June,
 * 29 September and 25 December") in the year of a date that already has provenance.
 */
export function recurringDates(answer: string, agreement: string, known: string[]): string[] {
  const years = new Set(known.map((d) => parseDate(d)?.getUTCFullYear()).filter((y): y is number => y !== undefined));
  // (known dates may be given as yyyy-mm-dd)
  if (!years.size) return [];
  const dm = new Set<string>();
  for (const m of agreement.slice(0, 200_000).matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\b(?!,?\\s+\\d{4})|\\b${MONTH_NAME}\\b\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s+\\d{4})`, "gi"))) {
    const day = Number(m[1] ?? m[4]);
    const mon = monthIndex(m[2] ?? m[3]);
    if (day >= 1 && day <= 31 && mon >= 0) dm.add(`${mon}-${day}`);
  }
  const out: string[] = [];
  for (const m of answer.slice(0, MAX_TEXT).matchAll(DATE_TERM_G)) {
    const d = parseDate(m[0]);
    if (d && dm.has(`${d.getUTCMonth()}-${d.getUTCDate()}`) && years.has(d.getUTCFullYear())) out.push(m[0]);
  }
  return out;
}
export function weekdayChecks(text: string): { ok: string[]; wrong: string[] } {
  const ok: string[] = [];
  const wrong: string[] = [];
  const t = text.slice(0, MAX_TEXT);
  const check = (w: string, dt: string, whole: string) => {
    const d = parseDate(dt);
    if (!d) return;
    (WEEKDAYS[d.getUTCDay()] === w.toLowerCase() ? ok : wrong).push(whole);
  };
  for (const m of t.matchAll(new RegExp(`\\b${WEEKDAY},?\\s+(?:the\\s+)?(${DATE_TERM.source})`, "gi"))) check(m[1], m[2], m[0]);
  for (const m of t.matchAll(new RegExp(`(${DATE_TERM.source}),?\\s*(?:\\(\\s*|which is\\s+|is\\s+|,\\s*)?(?:a\\s+)?${WEEKDAY}\\b`, "gi"))) check(m[m.length - 1], m[1], m[0]);
  return { ok, wrong };
}
/** "100 < 120" = "true": true when the stated truth value is right, false when wrong, null when not a comparison. */
export function checkComparison(expression: string, result: string): boolean | null {
  const m = /^\s*(.+?)\s*(<=|>=|<|>|=|≤|≥)\s*(.+?)\s*$/.exec(expression);
  if (!m) return null;
  const a = evaluate(m[1]);
  const b = evaluate(m[3]);
  const said = /^\s*(true|yes)\b/i.test(result) ? true : /^\s*(false|no)\b/i.test(result) ? false : null;
  if (a === null || b === null || said === null) return null;
  const truth = m[2] === "<" ? a < b : m[2] === ">" ? a > b : m[2] === "<=" || m[2] === "≤" ? a <= b : m[2] === ">=" || m[2] === "≥" ? a >= b : Math.abs(a - b) < 1e-9;
  return truth === said;
}
export function checkCalculations(calcs: Calculation[], support: string[], question: string, topic: string, agreement: string[] = support): CalcCheck {
  const verified = new Set<string>();
  const recomputed = new Set<string>();
  const dates: string[] = [];
  // operands of calculations that checked out: they may appear in the answer, but (unlike results and calendar
  // constants) they're still checked for belonging to the right term, so a figure from a leading question used
  // in a calculation ("$5,000 x 12") is still caught
  const operandsOk = new Set<string>();
  const agreementInputs = new Set<string>();
  const failed: string[] = [];
  const wrong: string[] = [];
  const unproven: string[] = [];
  const qualified: string[] = [];
  const cited = supportSegments(support);
  const everywhere = supportSegments(agreement);
  const fromQuestion = new Set(valuesIn(question).map((v) => v.n));
  for (const m of normalize(question).matchAll(/\d[\d,]*(?:\.\d+)?/g)) fromQuestion.add(String(Number(m[0].replace(/,/g, ""))));
  const topicAnchors = anchors(`${question} ${topic}`);
  // "cost", "fee", "pay" and "invoice" are one topic: the synonym groups retrieval uses
  const groupsOf = (t: string) => new Set(normalize(t).split(/[^\p{L}]+/u).map((w) => GROUP_OF.get(w)).filter((g) => g !== undefined));
  const topicGroups = groupsOf(`${question} ${topic}`);
  const onTopic = (s: Seg) => [...s.a].some((w) => topicAnchors.has(w)) || [...groupsOf(s.t)].some((g) => topicGroups.has(g));
  const onTopicStrict = (s: Seg) => [...s.a].some((w) => !isRate(w) && topicAnchors.has(w));
  const has = (segs: Seg[], n: string, kind: Kind | null) => segs.filter((s) => s.v.some((x) => x.n === n && (kind === null || x.kind === kind || (kind !== "percent" && x.kind === "plain"))));
  const talk = normalize(`${question} ${topic}`);
  const agreementText = normalize(agreement.join(" \n "));
  const constant = (n: string) => CONSTANTS.some(([c, re]) => c === n && re.test(talk));
  const percentsAll = new Set(everywhere.flatMap((s) => s.v.filter((x) => x.kind === "percent").map((x) => x.n)));
  const overtime = /\b(?:overtime|time and a half|time-and-a-half|double time|1\.5 times|150%)\b/.test(agreementText);
  // a multiplier derived from a stated percentage: 1.2 from 20%, 0.015 from 1.5%, 0.8 from a 20% discount
  const percentsOnTopic = new Set([...cited, ...everywhere].filter(onTopicStrict).flatMap((s) => s.v.filter((x) => x.kind === "percent").map((x) => x.n)));
  // a multiplier from a stated percentage about the question: 1.2 from a 20% markup, 0.015 from 1.5% interest
  const derivedRate = (n: number) => [n * 100, (n - 1) * 100, (1 - n) * 100].some((p) => percentsOnTopic.has(String(+p.toFixed(6))));
  const derivedOffTopic = (n: number) => !derivedRate(n) && [n * 100, (n - 1) * 100, (1 - n) * 100].some((p) => percentsAll.has(String(+p.toFixed(6))));
  // Provenance: a figure or date is QUOTED (the binding agreement), the USER's (the question and earlier turns), or
  // DERIVED (the result of a step re-done here whose inputs each have provenance). Steps are re-done until nothing
  // new is learned, so a chain works in any order; a derived result is never accepted for being in the text.
  const quotedDates = datesIn(agreement.join("\n"), 400_000);
  // QUOTED figures: anywhere in the binding agreement, without clause labels and references
  const quotedNums = numbersInAll(stripRefs(stripClauses(agreement.join("\n"))));
  const userDates = datesIn(question);
  const derivedDates = new Set<string>();
  const dateKnown = (t: string) => {
    const d = parseDate(t);
    if (!d) return false;
    const k = iso(d);
    if (quotedDates.has(k) || userDates.has(k) || derivedDates.has(k)) return true;
    // the last day of a known date's month, or the first day of the next ("60 days from the end of the month")
    return [...quotedDates, ...userDates, ...derivedDates].some((x) => {
      const y = new Date(`${x}T00:00:00Z`);
      return iso(new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() + 1, 0))) === k || iso(new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() + 1, 1))) === k;
    });
  };
  // a clock step's start ("Monday 6:30 a.m.") is the user's or the agreement's: its weekday and time both appear there
  const said = normalize(`${question}\n${agreement.join("\n")}`.slice(0, 400_000));
  const clockKnown = (t: string) => {
    const m = /^(\w+)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i.exec(t.trim());
    if (!m) return false;
    // a 12-hour time needs its a.m./p.m., a 24-hour one its minutes; both must agree with the source
    if (!m[4] && !m[3]) return false;
    const ap = m[4] ? `\\s*${/^a/i.test(m[4]) ? "a" : "p"}\\.?\\s?m\\.?` : "(?!\\s*[ap]\\.?\\s?m)";
    const time = `${m[2]}${m[3] ? `[:.]${m[3]}` : "(?:[:.]00)?"}${ap}`;
    const day = m[1].toLowerCase();
    const phrase = new RegExp(`\\b(?:${day},?\\s+(?:at\\s+)?${time}|${time},?\\s+on\\s+(?:a\\s+|the\\s+)?${day})\\b`, "i");
    return phrase.test(said);
  };
  const countKnown = (n: string) => fromQuestion.has(n) || quotedNums.has(n) || has(everywhere, n, null).length > 0 || constant(n) || verified.has(n) || recomputed.has(n);
  const steps = calcs.slice(0, 10).map((x) => ({ ...x, expression: stripNotes(x.expression) }));
  let size = -1;
  for (let pass = 0; pass < 4 && size !== verified.size + recomputed.size + derivedDates.size; pass++) {
    size = verified.size + recomputed.size + derivedDates.size;
    failed.length = 0;
    wrong.length = 0;
    unproven.length = 0;
    qualified.length = 0;
  for (const c of steps) {
    const label = `${c.expression} = ${c.result}`;
    // calendar steps: re-done here; the count and the base date need provenance, and the dates they reach are derived
    const calendar = checkDateStep(c.expression, c.result);
    const monthDay = calendar ? null : checkMonthDayStep(c.expression, c.result);
    if (monthDay) {
      // the base month holds a known date, and the count and the day are each known
      const monthKnown = [...quotedDates, ...userDates, ...derivedDates].some((x) => Number(x.slice(0, 4)) === monthDay.month.y && Number(x.slice(5, 7)) - 1 === monthDay.month.m);
      if (!monthDay.ok) {
        failed.push(label);
        wrong.push(label);
      } else if (!monthKnown || !countKnown(monthDay.count) || !countKnown(monthDay.day)) {
        failed.push(label);
        unproven.push(label);
      } else
        for (const d of monthDay.dates) {
          dates.push(d);
          const p = parseDate(d);
          if (p) derivedDates.add(iso(p));
        }
      continue;
    }
    const holiday = calendar ? null : checkHolidayRoll(c.expression, c.result, agreement.join("\n"));
    if (holiday) {
      if (!holiday.ok) {
        failed.push(label);
        wrong.push(label);
      } else if (!dateKnown(holiday.dates[0])) {
        failed.push(label);
        unproven.push(label);
      } else
        for (const d of holiday.dates) {
          dates.push(d);
          const p = parseDate(d);
          if (p) derivedDates.add(iso(p));
        }
      continue;
    }
    const zeroStep = checkThresholdZero(c.expression, c.result);
    if (zeroStep) {
      // both figures known, and the threshold is one the agreement states
      if (!zeroStep.ok) {
        failed.push(label);
        wrong.push(label);
      } else if (!countKnown(zeroStep.a) || !(quotedNums.has(zeroStep.b) || has(everywhere, zeroStep.b, null).length > 0)) {
        failed.push(label);
        unproven.push(label);
      } else {
        // a derived zero: its term is the verifier's call, like any re-done result
        recomputed.add("0");
        operandsOk.add("0");
      }
      continue;
    }
    const working = calendar ? null : checkNextWorkingDay(c.expression, c.result);
    const clock = calendar || working ? null : checkClockStep(c.expression, c.result);
    const span = calendar || working || clock ? null : checkSpan(c.expression, c.result);
    if (calendar || working || clock || span) {
      const ok = (calendar ?? working ?? clock ?? span)!.ok;
      if (!ok) {
        failed.push(label);
        wrong.push(label);
        continue;
      }
      const base = calendar ? calendar.dates[0] : working ? working.dates[0] : null;
      const count = calendar?.count ?? clock?.count ?? null;
      // every input has provenance: a base date, the count, both ends of a span, and a
      // clock step's starting day and time (in the user's words or the agreement)
      const inputsKnown =
        (base === null || dateKnown(base)) &&
        // a monthly series: the Nth date is N-1 months after the first, when the result names itself the Nth
        (count === null || countKnown(count) || (calendar !== null && /\bmonths?\b/i.test(c.expression) && new RegExp(`\\b${Number(count) + 1}(?:st|nd|rd|th)\\b`, "i").test(c.result.replace(new RegExp(DATE_TERM.source, "gi"), " ")) && new RegExp(`\\b${Number(count) + 1}(?:st|nd|rd|th)?\\b`, "i").test(question))) &&
        // a holiday may be a day and month the agreement lists without a year ("Easter Monday 6 April"), in the base
        // date's year
        (span === null || span.dates.every(dateKnown)) &&
        (clock === null || clockKnown(clock.text[0]));
      if (!inputsKnown) {
        failed.push(label);
        unproven.push(label);
        continue;
      }
      // the step's checked inputs (a known base date, both known ends of a span, a known clock start) and what it
      // reaches have provenance
      const reached = span ? span.dates : calendar ? calendar.dates : working ? working.dates : clock!.text;
      for (const d of reached) {
        dates.push(d);
        const p = parseDate(d);
        if (p) derivedDates.add(iso(p));
      }
      if (count !== null) operandsOk.add(count);
      if (span) recomputed.add(span.count);
      continue;
    }
    const cmp = checkComparison(c.expression, c.result);
    if (cmp !== null) {
      if (!cmp) {
        failed.push(label);
        wrong.push(label);
      }
      continue;
    }
    const value = evaluate(c.expression);
    const operands = [...c.expression.replace(/\b(?:min|max|round)\b/gi, " ").replace(/[×x÷]/g, " ").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "").matchAll(OPERAND)].map((m) => ({ n: String(Number(m[2].replace(/,/g, ""))), kind: (m[1] ? "money" : m[3] ? "percent" : null) as Kind | null }));
    let offTopic = false;
    const known = (o: { n: string; kind: Kind | null }) => {
      if (verified.has(o.n) || operandsOk.has(o.n) || fromQuestion.has(o.n)) return true;
      if (o.kind === null && constant(o.n)) return true;
      if (o.kind === null && o.n === "100" && operands.some((x) => x.n !== "100" && percentsAll.has(x.n))) return true;
      if (o.kind === null && (derivedRate(Number(o.n)) || (overtime && (o.n === "1.5" || o.n === "2")))) return true;
      if (o.kind === null && derivedOffTopic(Number(o.n))) {
        offTopic = true;
        return true;
      }
      // a rate must come from a clause that shares a word with the question or answer ("interest"), not just a
      // payment synonym; other figures may match by synonym ("cost" ~ "fee")
      const topical = o.kind === "percent" ? onTopicStrict : onTopic;
      if (has(cited, o.n, o.kind).some(topical) || has(everywhere, o.n, o.kind).some(topical)) return true;
      // stated in the agreement, but in a clause that isn't about the question
      if (has(everywhere, o.n, o.kind).length) {
        offTopic = true;
        return true;
      }
      return false;
    };
    const m = RESULT.exec(c.result);
    const stated = m ? Number(m[1].replace(/,/g, "")) : NaN;
    const labelFigures = m ? [...m[2].matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((x) => String(Number(x[0].replace(/,/g, "")))) : [];
    // "1.5% * 12 = 18%": the parser gives 0.18; a result written as a percentage is compared as one
    const pct = m ? /^\s*[$£€]?\s*-?\d[\d,]*(?:\.\d+)?\s*%/.test(c.result) : false;
    const target = value !== null && pct ? value * 100 : value;
    // a result marked as rounded ("≈ 1,067", "3.33 (rounded)") may differ by half a unit of its own last digit;
    // "not rounded" isn't a marker, and "0.94 (rounded)" for 0.45 is wrong
    const rounded = (/\b(?:approx\w*|about|around|rounded|roughly)\b|≈|~/i.test(c.result) && !/\b(?:not|un)[\s-]*rounded\b|\bexact(?:ly)?\b/i.test(c.result));
    const places = m ? (/\.(\d+)/.exec(m[1])?.[1].length ?? 0) : 0;
    const tolerance = rounded ? 0.5 * 10 ** -places : 0.005;
    const arithmeticOk = value !== null && target !== null && Number.isFinite(stated) && Math.abs(target - stated) <= tolerance + Math.abs(target) * 1e-9;
    if (value !== null && target !== null && Number.isFinite(stated) && !arithmeticOk) {
      failed.push(label);
      wrong.push(label);
      continue;
    }
    const unprove = (why: string) => {
      failed.push(why);
      unproven.push(why);
    };
    // nothing to re-do (prose, units, a comparison of words): the verifier judges it; its figures still face the checks
    // on the answer's text
    if (!arithmeticOk || operands.length === 0) {
      unprove(label);
      continue;
    }
    const stated_ = (o: { n: string; kind: Kind | null }) =>
      recomputed.has(o.n) || verified.has(o.n) || fromQuestion.has(o.n) || quotedNums.has(o.n) || has(everywhere, o.n, null).length > 0 || (o.kind === null && (CONSTANTS.some(([c]) => c === o.n) || o.n === "100" || [Number(o.n) * 100, (Number(o.n) - 1) * 100, (1 - Number(o.n)) * 100].some((p) => percentsAll.has(String(+p.toFixed(6))))));
    if (operands.every(stated_)) {
      for (const o of operands) recomputed.add(o.n);
      recomputed.add(String(Number(stated)));
      recomputed.add(String(Number(value!.toFixed(2))));
      recomputed.add(String(Math.round(value!)));
    }
    if (!operands.every(known)) {
      unprove(label);
      continue;
    }
    // a figure taken from a clause that isn't about the question makes the result a material claim it doesn't support
    if (offTopic) {
      unprove(`${label} (uses a figure from an unrelated clause)`);
      continue;
    }
    // a label may restate known figures ("9500 (monthly cap; 3800 is below it)"), not add new ones ("48 plus a $900 fee")
    const knownFig = (n: string) => verified.has(n) || recomputed.has(n) || fromQuestion.has(n) || quotedNums.has(n) || has(everywhere, n, null).length > 0 || n === String(Number(stated));
    if (labelFigures.some((n) => !knownFig(n) && !knownFig(String(Number(n) - 1)) && !knownFig(String(Number(n) + 1)))) {
      unprove(label);
      continue;
    }
    for (const o of operands) {
      if (o.kind === null && constant(o.n)) verified.add(o.n);
      else operandsOk.add(o.n);
      // an input found in the agreement (not taken from the question) has had its source checked here
      if (!fromQuestion.has(o.n) && (has(everywhere, o.n, o.kind).length || derivedRate(Number(o.n)))) agreementInputs.add(o.n);
    }
    verified.add(String(Number(stated)));
    verified.add(String(Number(value!.toFixed(2))));
    verified.add(String(Math.round(value!)));
  }
  }
  return { verified, operands: operandsOk, fromAgreement: agreementInputs, failed, wrong, unproven, qualified, recomputed, dates };
}

// ---- quotations inside the answer ----
/** Text the answer puts in quotation marks (three words or more) that isn't in the cited passages. */
export function misquoted(answer: string, support: string[]): string[] {
  const hay = normalize(support.join(" \n "));
  const out: string[] = [];
  for (const m of answer.slice(0, MAX_TEXT).matchAll(/["“](?![),.;:])([^"“”]{8,300})["”]|(?:^|[\s(])['‘]([^'‘’]{8,300})['’](?=[\s.,;:)!?]|$)/g)) {
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
  const parts = [
    at >= 0 ? q.slice(at) : "",
    ...[...q.matchAll(/\b(?:on|for|of|with)\s+(?:a|an)\s+[$£€]?\d[\d,.]*\s*(?:[a-z]+)?/g)].map((m) => m[0]),
    // the user's own situation: "the balance is now $4,200", "we worked 46 hours", "after 200 hours"
    ...q.split(/[,.;?]/).filter((x) => /\b(?:currently|balance|remaining|left|used|worked|works|spent|drops?|dropped|fell|falls|reach(?:es|ed)?|added|adding)\b/.test(x)),
    // "an overdue $3,200 invoice", "a late $4,000 payment"
    ...[...q.matchAll(/\b(?:a|an|the|my|our)\s+(?:(?:overdue|late|unpaid|outstanding|new|single|typical)\s+)?[$£€]\s?\d[\d,.]*\s*(?:[a-z]+)?/g)].map((m) => m[0]),
    // "after 200 hours on assignment", "within 3 days of delivery"
    ...[...q.matchAll(/\b(?:after|within|before|at|over)\s+(?:\d+(?:\.\d+)?|[a-z]+)\s+(?:hours?|days?|weeks?|months?|years?)\b/g)].map((m) => m[0]),
    // "for two weeks", "for 46 hours"
    ...[...q.matchAll(/\b(?:for|over|across)\s+(?:\d+(?:\.\d+)?|[a-z]+)\s+(?:hours?|days?|weeks?|months?|years?|units?|users?|people|staff)\b/g)].map((m) => m[0]),
    // "two months late", "10 days overdue"
    ...[...q.matchAll(/\b(?:\d+|[a-z]+)\s+(?:days?|weeks?|months?|years?|hours?)\s+(?:late|overdue|early|after|before|in)\b/g)].map((m) => m[0]),
  ];
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
  // "$48 per month, which is 1.5% of $3,200"
  for (const m of t.matchAll(new RegExp(String.raw`${NUM}(?:\s+[a-z]+){0,3},?\s+(?:which is|that is|i\.e\.|being)\s+(\d+(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?${NUM}`, "gi")))
    out.push({ expression: `${n(m[3])} * ${m[2]}%`, result: n(m[1]) });
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

/**
 * Negations in the answer, judged against the cited sentences most about the same thing. BLOCK when such a sentence
 * shares at least two content words and has no negation: "Either party may not terminate" against "Either party
 * may terminate on 45 days' notice". QUALIFY when the match is weak or the answer is hedged ("appears to").
 * Refuting the user's own premise ("$610, not $250"; "the waiver is not free" when the question says it's free) and
 * statements of absence aren't negated facts.
 */
// agreeing with the user's claim ("yes, that's correct", "the claim ... matches the agreement"), not "can't confirm"
const AFFIRMS = { test: (x: string) => /\b(?:yes|correct|matches|accurate|true|confirms|consistent with|agrees with|is what the agreement says)\b/i.test(x) && !/\b(?:not|n['’]t|cannot|unable to|no)\s+(?:\w+\s+)?(?:correct|accurate|true|confirm\w*|match\w*|consistent)\b/i.test(x) };
const REFUTE_SENTENCE_RAW = /\b(?:can['’]?t|cannot|could not|unable to)\s+(?:confirm|verify|agree)\b|\bno such (?:term|clause|provision|right)\b|\b(?:claim|assertion|suggestion|statement|premise)s?\s+(?:that|in the question)\b|\b(?:does not|doesn['’]?t|did not)\s+come from\b|\bisn['’]?t (?:in|from) the agreement\b|\bis not (?:in|from) the agreement\b/i;
const PREMISE = /\b(?:since|given that|claims?|claimed|says?|said|told|emailed|confirm\w*|isn['’]?t it|right\?|correct\?|true that|is it true|apparently|i heard)\b/i;
/** A sentence that disputes the user's claim, and doesn't also agree with it. */
const REFUTE_SENTENCE = { test: (x: string) => REFUTE_SENTENCE_RAW.test(x) && !AFFIRMS.test(x) && /\b(?:not|n['’]t|no such|cannot|set aside|disregard\w*|ignor\w*|unsupported)\b/i.test(x) };
export function negationCheck(answer: string, support: string[], question: string, absenceFree: (s: string) => string, o: { lenient?: boolean } = {}): { block: string[]; qualify: string[] } {
  // each clause of the cited text has its own subject ("...the Licensee shall pay only the shortfall and the
  // Licensor shall bear the costs of the audit")
  const segs = support.flatMap(segments).flatMap(clauses).map((t) => ({ t, a: anchors(t) }));
  const all = normalize(support.join(" \n "));
  const block: string[] = [];
  const qualify: string[] = [];
  for (const raw of clauses(answer.replace(REPLY, "$1"))) {
    // a sentence that disputes a claim ("I can't confirm the emailed claim that the waiver is now free", "the
    // agreement contains no such term") is a refutation, not a term
    if (REFUTE_SENTENCE.test(raw)) continue;
    // "With no overtime, the overtime rate does not apply": a consequence of the user's own stated scenario
    const qn = normalize(question);
    // ...but only when the cited text doesn't address that thing ("With no notice, the Client can still terminate"
    // when the cited clause requires notice is a claim to check)
    const citedWords = new Set(segs.flatMap((sg) => [...sg.a]));
    const unaddressed = (phrase: string) => [...anchors(phrase)].filter((w) => !isRate(w)).every((w) => !citedWords.has(w));
    const lead = /^\s*(?:if|with|since|given|because|as|when|assuming)\b([^,]{3,60}),(.*)$/i.exec(raw);
    if (lead && qn.includes(normalize(lead[1]).replace(/^(?:the|a|an)\s+/, "").trim())) {
      // the user's scenario. If the agreement doesn't address it, it's theirs; if it does, only a consequence that
      // something doesn't apply follows from it ("With no overtime, the overtime rate does not apply"), not a
      // permission the agreement doesn't give ("With no notice, the Client can still terminate")
      if (unaddressed(lead[1])) continue;
      if (/\b(?:not|n['’]t|no longer|never)\b/i.test(lead[2])) continue;
      block.push(`"${normalize(lead[1]).trim()}"`);
      continue;
    }
    let c = absenceFree(raw).replace(BOUNDS, " ").replace(AFFIRMING_NEGATION, " ");
    // "with no overtime" repeated from the user's own question is their scenario, not a term
    c = c.replace(/\b(?:no|not|without)\s+[a-z]+(?:\s+[a-z]+)?/g, (m) => (qn.includes(m) && unaddressed(m) ? " " : m));
    // the user asserted something ("Since the fee is now $0", "the emailed claim that the waiver is free"): an
    // answer that says "not $0" / "not free" is correcting the premise, not stating a negated term
    c = stripRefutations(c, question);
    const words = [...c.matchAll(NEG_WORD)].map((m) => m[1]);
    if (!words.length) continue;
    const hedged = /\b(?:appears?|seems?|likely|probably|arguably|might)\b/.test(c);
    const a = [...anchors(c)].filter((w) => !isRate(w));
    const overlap = (s: { a: Set<string> }) => a.filter((w) => s.a.has(w)).length;
    const best = Math.max(0, ...segs.map(overlap));
    // the cited sentences about the same thing: the best match, and any other that shares at least two words
    // (one shared generic word, like "pay" between "late payment interest" and "fees paid are not refundable", isn't
    // support; without a sentence sharing two words, a negation is unsupported)
    const near = best >= 2 ? segs.filter((s) => overlap(s) >= 2) : [];
    for (const w of words) {
      const special = /^(?:waived?|free|zero)$/.test(w);
      const has = (t: string) => (special ? new RegExp(`\\b${w.replace(/d$/, "")}`).test(normalize(t)) : NEG.test(normalize(t)) || BOUNDS.test(normalize(t)));
      // a material negation about something no cited sentence addresses has nothing behind it
      const moneyish = special || w === "nothing" || normalize(c).split(/[^\p{L}]+/u).some((x) => [0, 1, 6, 9, 11].includes(GROUP_OF.get(x) ?? -1));
      if (near.some((s) => has(s.t)) || (best === 0 && has(all) && !special && !moneyish)) continue;
      // saying money isn't owed ("owes nothing", "no fees apply", "the fee is waived") is material however weak the match
      // payment (0), termination (1), liability (6), late payment and interest (9), refunds (11): material terms
      const money = special || w === "nothing" || normalize(c).split(/[^\p{L}]+/u).some((x) => [0, 1, 6, 9, 11].includes(GROUP_OF.get(x) ?? -1));
      if (o.lenient) {
        // the explanation: a negation about payment, termination, liability, interest or refunds blocks as in the
        // answer; any other only when it plainly contradicts a closely matching clause
        if ((money && w !== "without") || (!hedged && best >= 2 && w !== "without")) block.push(`"${w}"`);
        continue;
      }
      ((money || (!hedged && best >= 2)) ? block : qualify).push(`"${w}"`);
    }
  }
  return { block: [...new Set(block)], qualify: [...new Set(qualify)] };
}

/**
 * Sums and rates the answer gives per one period ("an annual fee of $3,200", "1.5% per year", "$3,200, billed
 * annually") that the agreement gives per another ("per month").
 */
export function periodConflicts(answer: string, support: string[]): string[] {
  const TAGS: [RegExp, string][] = [[/\bhour(?:ly)?\b/, "hour"], [/\b(?:day|daily)\b/, "day"], [/\bweek(?:ly)?\b/, "week"], [/\bmonth(?:ly)?\b/, "month"], [/\b(?:year|annum|yearly|annual|annually)\b/, "year"]];
  const rate = (text: string) => {
    const out: { n: string; tag: string }[] = [];
    for (const sentence of normalize(text).split(/(?<=[.;!?])\s+/)) {
      for (const m of sentence.matchAll(/([$£€]\s?(\d[\d,]*(?:\.\d+)?))|(\d+(?:\.\d+)?)\s?%/g)) {
        const n = String(Number((m[2] ?? m[3]).replace(/,/g, "")));
        const at = m.index ?? 0;
        const after = sentence.slice(at + m[0].length, at + m[0].length + 28);
        const before = sentence.slice(Math.max(0, at - 24), at);
        // nearest period word: right after the figure ("per month", ", billed annually"), else just before ("annual fee of")
        const lead = before.split(/[$£€]|\d/).at(-1) ?? "";
        // "annual fee of $3,200" names the figure's period; "raise the monthly fee by up to 5%" doesn't
        const leadNames = /\b(?:hourly|daily|weekly|monthly|yearly|annual)\s+[a-z]+(?:\s+[a-z]+)?\s+(?:of|is|was|at|=|:)\s*$/.test(lead);
        const tag = TAGS.find(([re]) => re.test(after.split(/\b(?:and|but|or)\b|[$£€]|\d/)[0]))?.[1] ?? (leadNames ? TAGS.find(([re]) => re.test(lead))?.[1] : undefined);
        if (tag) out.push({ n, tag });
      }
    }
    return out;
  };
  const stated = support.flatMap(rate);
  return [...new Set(rate(answer).filter((a) => stated.some((s) => s.n === a.n) && !stated.some((s) => s.n === a.n && s.tag === a.tag)).map((a) => `${a.n} per ${a.tag}`))];
}

/** "$610, not $250" / "is not free" when the question asserted $250 or "free": the corrected premise is removed. */
export function stripRefutations(text: string, question: string): string {
  // sentences about the user's claim ("The question's claim that the partner rate is now $250 does not come from
  // the agreement") aren't terms
  text = text.split(/(?<=[.!?])\s+/).filter((x) => !REFUTE_SENTENCE.test(x)).join(" ");
  const qAnchors = anchors(question);
  const qNums = new Set(valuesIn(question).map((v) => v.n));
  const qAll = new Set([...normalize(question).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => String(Number(m[0].replace(/,/g, "")))));
  for (const n of qAll) qNums.add(n);
  // "so 30 days isn't enough": the user's figure, corrected
  text = text.replace(/([$£€]?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:%|(?:business |calendar |working )?(?:hours?|days?|weeks?|months?|years?))?['’]?(?:\s+\w+){0,2})\s+(?:isn['’]?t|is not|wouldn['’]?t be|would not be|won['’]?t be|falls short|is too (?:short|low|little))(?:\s+(?:enough|sufficient|correct|right|valid))?/gi, (m, _p, num: string) => (qNums.has(String(Number(num.replace(/,/g, "")))) ? " " : m));
  return text.replace(/\b(?:not|no|never|isn['’]?t|aren['’]?t|rather than|instead of)\s+((?:[^,.;:]|(?<=\d)[,.](?=\d))+)/gi, (m, tail: string) => {
    if (tail.length > 60) return m;
    const tv = [...tail.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((x) => String(Number(x[0].replace(/,/g, ""))));
    const ta = [...anchors(tail)].filter((w) => !isRate(w));
    return (tv.length > 0 && tv.every((n) => qNums.has(n))) || (PREMISE.test(question) && ta.length > 0 && ta.every((w) => qAnchors.has(w))) ? " " : m;
  });
}

/** The content words right after a figure and its unit: what the figure is of ("30 days' notice" -> notice). */
const WORD_NUM: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12", fourteen: "14", fifteen: "15", twenty: "20", thirty: "30", "forty-five": "45", sixty: "60", ninety: "90" };
function headsAfter(text: string, n: string): Set<string> {
  const t = normalize(text).replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|fifteen|twenty|thirty|forty-five|sixty|ninety)\b/g, (w) => WORD_NUM[w]);
  const out = new Set<string>();
  const num = n.replace(/\./g, "\\.");
  const re = new RegExp(`(?:^|[^\\d.])(?:[$£€]\\s?)?${num}(?:[\\d,]*)\\s*(?:\\(\\s*\\d+\\s*\\)\\s*)?(?:%|percent|(?:business|calendar|working)\\s+)?(?:hours?|days?|weeks?|months?|years?)?['’]?s?\\s+((?:[a-z'’-]+\\s+){0,2}[a-z'’-]+)`, "g");
  for (const m of t.matchAll(re)) for (const w of anchors(m[1])) if (!isRate(w)) out.add(w);
  return out;
}

// ---- comparisons the answer makes between the user's figure and the agreement's ----
const LE = /\b(?:falls?\s+(?:in|within|inside|under)|is\s+(?:within|inside|under|below)|(?:is\s+)?(?:fewer|less|shorter|lower)\s+than|within)\b/i;
const GE = /\b(?:exceeds?|(?:is\s+)?(?:more|greater|longer|higher)\s+than|is\s+(?:over|above|outside)|falls?\s+outside)\b/i;
const UNIT_DAYS: [RegExp, number][] = [[/^hours?/, 1 / 24], [/^(?:business |calendar |working )?days?/, 1], [/^weeks?/, 7], [/^fortnights?/, 14], [/^months?/, 30], [/^years?/, 365]];
/** The figure n in the text, in days when it's a period ("2 weeks" -> 14), or as is. */
function amountOf(text: string, n: string): number | null {
  const t = normalize(text).replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|fifteen|twenty|thirty|forty-five|sixty|ninety)\b/g, (w) => WORD_NUM[w]);
  const re = new RegExp(`(?:^|[^\\d.])[$£€]?\\s?${n.replace(/\./g, "\\.")}(?![\\d.])\\s*(?:\\(\\s*\\d+\\s*\\)\\s*)?([a-z ]{0,20})`);
  const m = re.exec(t);
  if (!m) return null;
  const unit = UNIT_DAYS.find(([u]) => u.test(m[1].trim()));
  return Number(n) * (unit ? unit[1] : 1);
}
/**
 * Whether a comparison the answer states is true: "paying 30 days after invoice is within the payment terms" when
 * the terms say 15 days is false. Compared with another figure of the same kind in the clause, or else the cited
 * sentence about the same thing. Null when there's no comparison or nothing to compare with.
 */
export function comparisonHolds(clause: string, n: string, support: string[]): boolean | null {
  const le = LE.test(clause);
  const ge = GE.test(clause);
  if (le === ge) return null;
  const mine = valuesIn(clause).find((v) => v.n === n);
  if (!mine) return null;
  const x = amountOf(clause, n);
  // "falls in the 89-to-30-day window", "between 30 and 89 days": within a range means between its ends
  const range = /(\d+(?:\.\d+)?)\s*(?:-\s*to\s*-|-|–|\bto\b|\band\b)\s*(\d+(?:\.\d+)?)\s*-?\s*(?:business |calendar |working )?(?:day|week|month|year|hour)/i.exec(clause.replace(/\bbetween\s+/i, ""));
  if (range && le && x !== null) {
    const unit = /(?:week)/i.test(range[0]) ? 7 : /month/i.test(range[0]) ? 30 : /year/i.test(range[0]) ? 365 : /hour/i.test(range[0]) ? 1 / 24 : 1;
    const [lo, hi] = [Number(range[1]) * unit, Number(range[2]) * unit].sort((p, q) => p - q);
    if (!(range[1] === n || range[2] === n)) return x >= lo && x <= hi;
  }
  let other = valuesIn(clause).find((v) => v.n !== n && v.kind === mine.kind && v.kind !== "plain");
  let y = other ? amountOf(clause, other.n) : null;
  if (y === null) {
    const a = [...anchors(clause)].filter((w) => !isRate(w));
    const segs = supportSegments(support).map((s) => ({ s, k: a.filter((w) => s.a.has(w)).length, vals: s.v.filter((v) => v.kind === mine.kind && v.kind !== "plain") }));
    const best = segs.filter((x) => x.k > 0 && x.vals.length === 1).sort((p, q) => q.k - p.k)[0];
    if (!best) return null;
    other = best.vals[0];
    y = amountOf(best.s.t, other.n);
  }
  if (x === null || y === null) return null;
  return le ? x <= y : x > y;
}
/** Figures that appear only in comparisons that hold ("30 days is fewer than the 45 days required"). */
export function figuresInTrueComparisons(text: string, support: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of clauses(text)) for (const v of valuesIn(c)) if (comparisonHolds(c, v.n, support) === true) out.add(v.n);
  return out;
}
