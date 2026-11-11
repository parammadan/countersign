// Agreement Studio form: from what the person typed to what is sent to the generator. Pure, so it is unit-tested.
//
// Number fields keep the typed text (they are text inputs with a numeric keypad, not <input type="number">: a number
// input reports "" for anything that isn't a bare number, so "30 days" looked filled in but was sent as missing).
// Nothing here guesses: a value is either read exactly ("30", "30 days", "1.5%", "15,000 USD" → "USD 15,000") or
// reported against its own field. The generator still validates every value itself.
import type { KindSpec } from "@/lib/drafts/service";
import { TERM_LABEL } from "@/lib/drafts/labels";

export type FieldError = { key: string; text: string };

/** The unit a whole-number term is counted in, from its label ("Notice period (days)" → "day"). */
function unitOf(key: string): string | null {
  const m = /\((days|years|months)\b/i.exec(TERM_LABEL[key] ?? "");
  return m ? m[1].toLowerCase().replace(/s$/, "") : null;
}

/** "30", "30 days", "1 day" → 30 / 1 (the unit must be the field's own); anything else → null. */
export function parseWhole(raw: string, key: string): number | null {
  const unit = unitOf(key);
  const m = new RegExp(`^\\s*(\\d{1,5})(?:\\s*${unit ? `${unit}s?` : "(?!)"})?\\s*$`, "i").exec(raw);
  return m ? Number(m[1]) : null;
}

/** "1.5", "1.5%", "2 %" → 1.5 / 2; anything else → null. */
export function parsePercent(raw: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** The ISO codes each currency symbol can stand for: a symbol and a code are only merged when they agree. */
const SYMBOL_CODES: Record<string, string[]> = { "$": ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"], "€": ["EUR"], "£": ["GBP"], "¥": ["JPY", "CNY"] };
const AMOUNT = "(\\d[\\d,]*(?:\\.\\d{1,2})?)";
/**
 * An amount in the generator's order ("USD 15,000"): "15,000 USD" → "USD 15,000"; a symbol and a matching code
 * together ("$5,000 USD", "USD $5,000") → "USD 5,000". A symbol and a code that disagree ("$5,000 EUR") are left
 * as typed for the generator to refuse: which currency was meant is never guessed.
 */
export function normaliseMoney(raw: string): string {
  const v = raw.trim();
  const after = new RegExp(`^${AMOUNT}\\s+([A-Za-z]{3})$`).exec(v);
  if (after) return `${after[2].toUpperCase()} ${after[1]}`;
  const both = new RegExp(`^(?:([$€£¥])\\s?${AMOUNT}\\s+([A-Za-z]{3})|([A-Za-z]{3})\\s?([$€£¥])\\s?${AMOUNT})$`).exec(v);
  if (both) {
    const [sym, amount, code] = both[1] ? [both[1], both[2], both[3]] : [both[5], both[6], both[4]];
    if (SYMBOL_CODES[sym]?.includes(code.toUpperCase())) return `${code.toUpperCase()} ${amount}`;
  }
  return v;
}

/** What to send for the current template's terms, or the fields that can't be read (each against its own key). */
export function termPayload(spec: KindSpec, terms: Record<string, string>): { terms: Record<string, string | number>; errors: FieldError[] } {
  const out: Record<string, string | number> = {};
  const errors: FieldError[] = [];
  for (const term of spec.terms) {
    const v = (terms[term.key] ?? "").trim();
    if (!v) continue;
    const name = TERM_LABEL[term.key] ?? term.key;
    if (term.type === "int") {
      const n = parseWhole(v, term.key);
      const unit = unitOf(term.key);
      if (n === null) errors.push({ key: term.key, text: `${name}: enter a whole number${unit ? ` of ${unit}s, like 30` : ""}.` });
      else out[term.key] = n;
    } else if (term.type === "percent") {
      const n = parsePercent(v);
      if (n === null) errors.push({ key: term.key, text: `${name}: enter a number, like 1.5.` });
      else out[term.key] = n;
    } else if (term.type === "money") out[term.key] = normaliseMoney(v);
    else out[term.key] = v;
  }
  return { terms: out, errors };
}

/** The form field a generator issue is about ("missing: term:fee" → "fee", "missing: party:Client" → "role:Client"). */
export function issueKey(issue: string): string {
  const missing = /^missing: (term|party):(.+)$/.exec(issue);
  if (missing) return missing[1] === "term" ? missing[2] : `role:${missing[2]}`;
  const party = /^party:([^:]+): /.exec(issue);
  if (party) return `role:${party[1]}`;
  const field = /^([^:\s]+): /.exec(issue);
  return field ? field[1] : "";
}
