// Closed list of licence territories. A territory is never free text: free-text word lists were bypassed round after
// round. Input is one name, or several separated by ";" ("France; Germany"); S1 joins them ("France and Germany").
// Matching ignores case and an optional leading "the" (so "United States", "the United States" and "THE UNITED
// STATES" are the same) and accepts a few full official names as aliases; anything else is invalid. Names that are ambiguous between
// a country and a sub-national region (e.g. Georgia) are left out on purpose. Keep this list modest and documented.

/** Rendered with "the". */
const WITH_THE = [
  "European Union", "European Economic Area", "United Kingdom", "United States", "United Arab Emirates",
  "Netherlands", "Czech Republic", "Philippines", "District of Columbia", "Northwest Territories",
];

const COUNTRIES = [
  // EU members (the Netherlands and the Czech Republic are in WITH_THE)
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece",
  "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Poland", "Portugal", "Romania",
  "Slovakia", "Slovenia", "Spain", "Sweden",
  // EEA, EFTA and other common jurisdictions
  "Iceland", "Liechtenstein", "Norway", "Switzerland", "Canada", "Mexico", "Brazil", "Argentina", "Chile", "Australia",
  "New Zealand", "Japan", "South Korea", "Singapore", "India", "Israel", "South Africa", "China", "Hong Kong", "Taiwan",
];
const UK_NATIONS = ["England", "Scotland", "Wales", "Northern Ireland", "England and Wales"];
const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Hawaii",
  "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
  "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
  "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
];
const CA_PROVINCES = [
  "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Nova Scotia", "Ontario",
  "Prince Edward Island", "Quebec", "Saskatchewan", "Nunavut", "Yukon",
];

/** Canonical input name -> rendered form. */
export const TERRITORIES: ReadonlyMap<string, string> = new Map([
  ...WITH_THE.map((n) => [n, `the ${n}`] as const),
  ...[...COUNTRIES, ...UK_NATIONS, ...US_STATES, ...CA_PROVINCES].map((n) => [n, n] as const),
]);
export const MAX_TERRITORIES = 10;
/** Full official names accepted for a listed short name. */
const ALIASES: Record<string, string> = {
  "United States of America": "United States", "United Kingdom of Great Britain and Northern Ireland": "United Kingdom",
  "Republic of Ireland": "Ireland", "Republic of Korea": "South Korea", "Kingdom of the Netherlands": "Netherlands",
};
const BY_KEY = new Map<string, string>([
  ...[...TERRITORIES].map(([n, r]) => [n.toLowerCase(), r] as const),
  ...Object.entries(ALIASES).map(([a, n]) => [a.toLowerCase(), TERRITORIES.get(n)!] as const),
]);

const EU = ["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"];
/** Explicit containment between listed names (a list may not name both a region and a part of it). */
const PARTS: Record<string, string[]> = {
  "European Union": EU,
  "European Economic Area": [...EU, "European Union", "Iceland", "Liechtenstein", "Norway"],
  "United Kingdom": [...UK_NATIONS],
  "England and Wales": ["England", "Wales"],
  "United States": [...US_STATES, "District of Columbia"],
  Canada: [...CA_PROVINCES, "Northwest Territories"],
};
const RENDERED_PARTS = new Map(Object.entries(PARTS).map(([k, v]) => [TERRITORIES.get(k)!, new Set(v.map((n) => TERRITORIES.get(n)!))]));
const contains = (outer: string, inner: string) => RENDERED_PARTS.get(outer)?.has(inner) ?? false;

/** Render "France; Germany; Italy" as "France, Germany and Italy", or return an error. */
export function renderTerritory(value: string): { ok: true; text: string } | { ok: false; error: string } {
  const parts = value.split(";").map((p) => p.trim().replace(/\s+/g, " ").replace(/^the\s+/i, ""));
  if (parts.length > MAX_TERRITORIES) return { ok: false, error: `at most ${MAX_TERRITORIES} territories` };
  const out: string[] = [];
  for (const p of parts) {
    const r = BY_KEY.get(p.toLowerCase());
    if (!r) return { ok: false, error: `"${p}" is not a listed territory (one listed name, or several separated by ";"; see territories.ts)` };
    if (out.includes(r)) return { ok: false, error: `"${p}" is listed twice` };
    if (out.some((o) => contains(o, r) || contains(r, o))) return { ok: false, error: `"${p}" overlaps another listed territory (one contains the other)` };
    out.push(r);
  }
  return { ok: true, text: out.length === 1 ? out[0] : `${out.slice(0, -1).join(", ")} and ${out.at(-1)}` };
}
