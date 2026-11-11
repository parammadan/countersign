import type { Clause } from "../shared/agreement-model";
import { TERM_TYPES, renderTerm } from "./terms";
import { TEMPLATES } from "./templates";
import type { AgreementTemplate, GenerateInput, TemplateClause, TermKey } from "./types";
import { unprintableChars } from "../doc-output/pdf-text";
import { mixedConfusableScripts, nameSkeleton, oddLatinLetters, operativeWords, scanInjection } from "./checks";

const MAX_NAME = 100;

export type Validated = { template: AgreementTemplate; rendered: Partial<Record<TermKey, string>>; issues: string[]; missing: string[]; unused: TermKey[] };

/** Validate structured input. Everything the final document states about parties and terms comes from here. */
export function validateInput(input: GenerateInput): Validated | { issues: string[]; template?: undefined } {
  const template = typeof input?.kind === "string" && Object.hasOwn(TEMPLATES, input.kind) ? TEMPLATES[input.kind] : undefined;
  if (!template) return { issues: [`kind: unknown agreement kind "${String(input?.kind)}"`] };
  if (!Array.isArray(input.parties)) return { issues: ["parties: expected a list"] };
  const issues: string[] = [];
  const missing: string[] = [];
  const rendered: Partial<Record<TermKey, string>> = {};
  if (input.instructions != null && typeof input.instructions !== "string") issues.push("instructions: expected text");

  for (const role of template.roles) {
    const p = input.parties.filter((x) => x?.role === role);
    if (p.length === 0) missing.push(`party:${role}`);
    else if (p.length > 1) issues.push(`party:${role}: given more than once`);
  }
  for (const p of input.parties) {
    if (!p || typeof p.role !== "string" || typeof p.name !== "string") { issues.push("party: malformed entry"); continue; }
    if (!template.roles.includes(p.role)) issues.push(`party:${p.role}: not a role of a ${template.kind} agreement`);
    const n = (p.name ?? "").trim();
    if (!n) { if (template.roles.includes(p.role)) missing.push(`party:${p.role}`); continue; }
    if (n.length > MAX_NAME || !/^[\p{L}\p{N} .,'&()-]+$/u.test(n)) issues.push(`party:${p.role}: name has unsupported characters or is too long`);
    else if (unprintableChars(n).length) issues.push(`party:${p.role}: name has characters the PDF cannot print yet (${unprintableChars(n).join(" ")}); a Unicode PDF font is a planned follow-up`);
    else if (n.normalize("NFKC") !== n) issues.push(`party:${p.role}: name has compatibility characters (fullwidth, ligatures)`);
    else if (oddLatinLetters(n)) issues.push(`party:${p.role}: name has unusual Latin letters (small capitals, dotless i and similar look-alikes)`);
    else if (mixedConfusableScripts(n)) issues.push(`party:${p.role}: name mixes Latin, Cyrillic or Greek letters (look-alike characters)`);
    else if (scanInjection(n).length) issues.push(`party:${p.role}: name contains instruction-like text`);
  }
  const named = input.parties.filter((p) => p && typeof p.name === "string" && typeof p.role === "string" && p.name.trim());
  for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
    if (named[i].role !== named[j].role && nameSkeleton(named[i].name) === nameSkeleton(named[j].name)) issues.push(`party:${named[j].role}: name is the same as, or looks like, the ${named[i].role}'s name`);
  }

  const terms = input.terms && typeof input.terms === "object" ? input.terms : {};
  const given = (k: string) => { const v = (terms as Record<string, unknown>)[k]; return v !== undefined && v !== null && String(v).trim() !== ""; };
  // An optional clause (or wording variant) appears when its term is given; every other term it uses is then
  // required (no defaults).
  for (const c of template.clauses) {
    if (c.when ? !given(c.when) : !(c.variants && given(c.variants.term))) continue;
    for (const m of clauseSource(c, terms).matchAll(/\{\{term:([^}]+)\}\}/g)) {
      const k = m[1] as TermKey;
      if (!given(k) && !template.requiredTerms.includes(k) && !missing.includes(`term:${k}`)) missing.push(`term:${k}`);
    }
  }
  for (const key of Object.keys(terms) as TermKey[]) {
    if (!Object.hasOwn(TERM_TYPES, key)) issues.push(`${key}: unknown term`);
  }
  for (const key of template.requiredTerms) {
    const v = terms[key];
    if (v === undefined || v === null || String(v).trim() === "") missing.push(`term:${key}`);
  }
  const partyRefs = [...template.roles, ...named.map((p) => p.name.trim())];
  for (const key of Object.keys(TERM_TYPES) as TermKey[]) {
    const v = terms[key];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const r = renderTerm(key, v);
    if (!r.ok) issues.push(r.error);
    else if ((TERM_TYPES[key] === "text" || TERM_TYPES[key] === "list") && scanInjection(r.text).length) issues.push(`${key}: contains instruction-like text`);
    else if (TERM_TYPES[key] === "text" && operativeWords(r.text, partyRefs, key === "licensedMaterial").length) issues.push(`${key}: must be a name or address only; it may not mention a party or contain obligation, payment, negation or licence-scope words (${operativeWords(r.text, partyRefs, key === "licensedMaterial").join(", ")})`);
    else rendered[key] = r.text;
  }
  if (terms.startDate && terms.endDate && String(terms.endDate).trim() <= String(terms.startDate).trim()) issues.push("endDate: must be after startDate");
  // Used = appears in a clause the draft will contain (a conditional clause only counts when its own term is given),
  // so a term that would not appear, e.g. a late-fee period without a late fee, is refused instead of dropped.
  const used = new Set<string>();
  for (const c of template.clauses) {
    if (c.when) { if (!given(c.when)) continue; used.add(c.when); }
    if (c.variants) used.add(c.variants.term);
    for (const m of clauseSource(c, terms).matchAll(/\{\{term:([^}]+)\}\}/g)) used.add(m[1]);
  }
  const unused = (Object.keys(rendered) as TermKey[]).filter((k) => !used.has(k));
  return { template, rendered, issues, missing, unused };
}

/** The wording a template clause uses for this input: its variant for the chosen value, else its own text. */
export function clauseSource(tc: TemplateClause, terms: Partial<Record<TermKey, string | number>>): string {
  if (tc.alt) {
    const a = (terms as Record<string, unknown>)[tc.alt.when];
    if (a !== undefined && a !== null && String(a).trim() !== "") return tc.alt.text;
  }
  if (!tc.variants) return tc.text;
  const v = (terms as Record<string, unknown>)[tc.variants.term];
  const key = v === undefined || v === null ? "" : String(v).trim();
  return key && Object.hasOwn(tc.variants.texts, key) ? tc.variants.texts[key] : tc.text;
}

const PLACEHOLDER = /\{\{(role|term|ref):([^}]+)\}\}/g;

/** Fill roles and terms. {{ref:id}} stays until numbering. Returns clauses in template order. */
export function fillTemplate(v: Validated, input: GenerateInput): Clause[] {
  const names = new Map(input.parties.map((p) => [p.role, p.name.trim()]));
  const out: Clause[] = [];
  for (const tc of v.template.clauses) {
    if (tc.when && v.rendered[tc.when] === undefined) continue;
    const text = clauseSource(tc, input.terms ?? {}).replace(PLACEHOLDER, (m, kind: string, key: string) => {
      if (kind === "role") return names.get(key) ?? m;
      if (kind === "term") return v.rendered[key as TermKey] ?? m;
      return m;
    });
    const c: Clause = { id: tc.id, heading: tc.heading, text };
    if (tc.locked) c.locked = true;
    out.push(c);
  }
  return out;
}

/** Deterministic numbering: 1..N in order; resolves {{ref:id}}. A ref to an omitted clause is an error. */
export function numberClauses(clauses: Clause[]): Clause[] {
  const num = new Map(clauses.map((c, i) => [c.id, String(i + 1)]));
  return clauses.map((c, i) => ({
    ...c,
    number: String(i + 1),
    text: c.text.replace(/\{\{ref:([^}]+)\}\}/g, (m, id: string) => num.get(id) ?? m),
  }));
}
