import type { TermKey, TermType } from "./types";
import { renderTerritory } from "./territories";

export const TERM_TYPES: Record<TermKey, TermType> = {
  fee: "money", rent: "money", deposit: "money",
  paymentDays: "int", noticeDays: "int", confidentialityYears: "int",
  startDate: "date", endDate: "date",
  lateFeePercent: "percent",
  governingLaw: "text", propertyAddress: "text",
  licensedMaterial: "text", territory: "territory",
  exclusivity: "choice", ipOwner: "choice", licensedUse: "choice", licenceTransfer: "choice", feePeriod: "choice",
  feeBasis: "choice", rentSchedule: "choice", premisesUse: "choice", subletting: "choice", lateFeePeriod: "choice",
};

/**
 * Choice terms: the user picks one value, and it renders as shown. There is no default: a missing choice is
 * needs_input. exclusivity renders with its article so the grant reads "grants the Licensee an exclusive licence".
 */
export const CHOICES: Partial<Record<TermKey, Record<string, string>>> = {
  exclusivity: { exclusive: "an exclusive", "non-exclusive": "a non-exclusive" },
  ipOwner: { Client: "Client", Consultant: "Consultant" },
  /** What the Licensee may do with the licensed material. */
  licensedUse: { use: "to use", "use and modify": "to use and modify", "use, modify and distribute": "to use, modify and distribute" },
  /** Whether the Licensee may pass the licence on: sublicense, assign OR transfer it (one answer covers all three, and
   *  the README and question to the user must say so). Passing it on freely is not offered: there is no safe wording. */
  licenceTransfer: { "not permitted": "in any circumstances", "with written consent": "without the Licensor's written consent" },
  /** Retainer fee period. A one-off retainer is not offered: one fee for open-ended services is not a safe reading. */
  feePeriod: { month: "per month", quarter: "per quarter", year: "per year" },
  /** Consulting, services and engagement: how the fee is charged. Optional: without it the fee clause keeps its plain
   *  wording ("a fee of $X for the services") and states no basis. Its wording comes from the clause's `variants`. */
  feeBasis: { fixed: "a one-time fixed fee", month: "per month", quarter: "per quarter", year: "per year" },
  /** Lease: how often and when rent is paid. */
  rentSchedule: {
    "monthly, in advance, on the first day": "per month, in advance, on the first day of each month",
    "monthly, in advance": "per month, in advance",
    "weekly, in advance": "per week, in advance",
  },
  /** Lease: what the Premises may be used for ("only" is there only when the user chose it). */
  premisesUse: { "residential use only": "residential use only", "residential use": "residential use" },
  /** Lease: whether the Tenant may sublet. */
  subletting: {
    "with written consent": "not sublet without the Landlord's written consent",
    "not permitted": "not sublet the Premises",
    permitted: "may sublet the Premises",
  },
  /** Services: how the late fee accrues. */
  lateFeePeriod: { month: "per month until paid", year: "per year until paid", once: "of the amount overdue" },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONEY = /^(?:(USD|EUR|GBP|CAD)\s?|([$€£]))(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?$/;
const TEXT = /^[A-Za-z0-9 .,'#/-]{2,80}$/;
/** A period inside a text term may only end one of these: initials (D.C., U.S.) or a common address abbreviation. */
const ABBREV = /^(?:(?:[A-Za-z]\.)+|(?:St|Mt|Ft|Ave|Av|Rd|Apt|Ste|Blvd|Dr|Ln|Ct|Pl|Sq|Fl|No|Bldg|Hwy|Pkwy|Rte|Ter|Terr|Cres|Cir|Pde|Hts|Pt|Ctr|N|S|E|W|NE|NW|SE|SW)\.)$/;
/** Lower-case words a jurisdiction or an address may contain; every other word must be capitalised (a name). */
const CONNECTORS: Partial<Record<TermKey, Set<string>>> = {
  governingLaw: new Set(["of", "and", "the"]),
  propertyAddress: new Set(["of", "and", "the", "at", "on", "in", "upon", "de", "la", "le", "du", "del", "da", "van", "von", "der", "den", "ter", "het", "floor", "c/o"]),
};
const MAX_WORDS: Partial<Record<TermKey, number>> = { governingLaw: 8, propertyAddress: 16, licensedMaterial: 12 };
/**
 * licensedMaterial names a thing: capitalised words (product names), connectors, and lower-case words only from this
 * small noun list. No verbs, pronouns or "in"/"to", so the value cannot add rights or places to the grant.
 */
const MATERIAL_NOUNS = new Set(("the a an of and for software data dataset database documentation platform application app library content " +
  "materials material catalogue catalog images photographs music recordings designs model models tool toolkit set edition " +
  "source code files specification specifications manual guide course video videos text report reports map maps font fonts " +
  "patent patents trademark trademarks brand logo logos artwork artworks method process system web site website " +
  "analytics mobile desktop cloud online digital memory").split(" "));
/** Prepositions and joiners that would turn a material name into grant wording, refused in any case ("For Resale"). */
const MATERIAL_JOINERS = new Set(("in to for with including include includes excluding exclude excludes by on at from without except plus upon within under over into via per as and or future " +
  "new successor successors update updates release releases version versions upgrade upgrades").split(" "));

/**
 * A text term is one name-like phrase, never a sentence: no period except in an abbreviation, every word
 * capitalised or a known connector, and a bounded number of words. Returns why it is not, or null.
 */
export function textTermShape(key: TermKey, s: string): string | null {
  if (key === "governingLaw") {
    if (/\d/.test(s)) return "a jurisdiction name (no digits)";
    const parts = s.split(",");
    if (parts.length > 2 || (parts.length === 2 && parts[1].trim().split(/\s+/).length > 2)) return "a jurisdiction name (at most one comma, followed by a short region such as D.C.)";
  }
  const words = s.split(/[\s,]+/).filter(Boolean);
  if (words.length > (MAX_WORDS[key] ?? 16)) return `at most ${MAX_WORDS[key] ?? 16} words`;
  for (const w of words) {
    if (w.includes(".") && !ABBREV.test(w) && !/^\d+(?:\.\d+)?$/.test(w)) return "a single name or address, not a sentence (a period may only end an abbreviation)";
    if (key === "licensedMaterial" && MATERIAL_JOINERS.has(w.toLowerCase())) return `a name for the licensed material, without "${w}" (the grant's scope and place come only from licensedUse and territory)`;
    if (key === "licensedMaterial" && /^[a-z]/.test(w) && !MATERIAL_NOUNS.has(w.replace(/'s$/, ""))) return `a name for the licensed material (capitalised names or plain nouns such as software, data or documentation; unexpected "${w}")`;
    if (key !== "licensedMaterial" && /^[a-z]/.test(w) && !CONNECTORS[key]?.has(w)) return `a name or address with capitalised words (unexpected "${w}")`;
  }
  return null;
}

export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Render a term value in its canonical wording, or return an error string. */
export function renderTerm(key: TermKey, value: string | number): { ok: true; text: string } | { ok: false; error: string } {
  const type = TERM_TYPES[key];
  const s = typeof value === "number" ? String(value) : String(value).trim();
  const bad = (why: string) => ({ ok: false as const, error: `${key}: ${why}` });
  switch (type) {
    case "money": {
      const m = MONEY.exec(s);
      if (!m) return bad("expected an amount with a currency, such as $5,000 or USD 5,000.00");
      const digits = m[3].replace(/,/g, "");
      if (/^0\d/.test(digits)) return bad("must not have leading zeros");
      const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const cur = m[1] ?? m[2];
      const num = withCommas + (m[4] ?? "");
      if (Number(digits + (m[4] ?? "")) <= 0) return bad("must be greater than zero");
      return { ok: true, text: cur.length === 1 ? cur + num : `${cur} ${num}` };
    }
    case "date": {
      if (!isRealDate(s)) return bad("expected a real date as YYYY-MM-DD");
      const [y, m, d] = s.split("-").map(Number);
      return { ok: true, text: `${MONTHS[m - 1]} ${d}, ${y}` };
    }
    case "int": {
      if (!/^\d{1,4}$/.test(s) || Number(s) < 1) return bad("expected a whole number of 1 or more");
      return { ok: true, text: String(Number(s)) };
    }
    case "percent": {
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(s) || Number(s) <= 0 || Number(s) > 100) return bad("expected a percentage above 0 and up to 100");
      return { ok: true, text: `${Number(s)}%` };
    }
    case "territory": {
      const r = renderTerritory(s);
      return r.ok ? r : bad(r.error);
    }
    case "choice": {
      const opts = CHOICES[key] ?? {};
      if (!Object.hasOwn(opts, s)) return bad(`expected one of: ${Object.keys(opts).join(", ")}`);
      return { ok: true, text: opts[s] };
    }
    case "text":
      if (!TEXT.test(s)) return bad("expected 2-80 plain characters (letters, digits, spaces and . , ' # / -)");
      {
        const why = textTermShape(key, s);
        if (why) return bad(`expected ${why}`);
      }
      return { ok: true, text: s };
  }
}
