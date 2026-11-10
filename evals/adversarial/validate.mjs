#!/usr/bin/env node
// Dependency-free validator for the adversarial verifier suite.
// Usage: node validate.mjs [path/to/cases.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "cases.json");
const data = JSON.parse(readFileSync(file, "utf8"));
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

const ERROR_TYPES = ["moved_figure", "wrong_party", "flipped_negation", "dropped_condition", "wrong_arithmetic", "wrong_date",
  "false_absence", "invented_term", "nonbinding_as_binding", "injection_followed", "false_premise_accepted", "smuggled_term", "laundered_calc"];
const KINDS = ["term", "absence", "calculation", "scenario", "context"];
const VERDICTS = ["supported", "contradicted", "unsupported", "uncertain"];
const STATUSES = ["answered", "partial", "not_found"];
const GENERIC = new Set(["yes", "no", "the", "a", "an", "and", "or", "is", "it", "not", "days", "months", "per", "year"]);

// ── agreements ──
if (!Array.isArray(data.agreements)) err("root", "agreements must be an array");
const agText = new Map();
for (const a of data.agreements || []) {
  if (agText.has(a.id)) err(`agreement ${a.id}`, "duplicate id");
  if (!Array.isArray(a.pages) || a.pages.length < 2 || a.pages.length > 4 || a.pages.some((p) => typeof p !== "string" || !p.trim()))
    err(`agreement ${a.id}`, "pages must be 2-4 non-empty strings");
  agText.set(a.id, (a.pages || []).map(norm));
}
const onSomePage = (agId, q) => (agText.get(agId) || []).some((p) => p.includes(norm(q)));

// ── helpers ──
function genTexts(gen) {
  const t = [];
  if (gen.answer) t.push(norm(gen.answer));
  if (gen.explanation) t.push(norm(gen.explanation));
  for (const c of gen.calculations || []) t.push(norm(`${c.expression} = ${c.result}`));
  for (const n of gen.not_stated || []) t.push(norm(n));
  return t;
}
function sentences(s) {
  return norm(s).split(/(?<=[.!?])\s+(?=[A-Z£$€0-9"'(])/).filter((x) => x.trim());
}
// coverage units: sentences of answer/explanation, whole calc strings, whole not_stated items
function units(gen) {
  const u = [];
  for (const field of ["answer", "explanation"]) if (gen[field]) for (const s of sentences(gen[field])) u.push({ text: norm(gen[field]), unit: s });
  for (const c of gen.calculations || []) { const s = norm(`${c.expression} = ${c.result}`); u.push({ text: s, unit: s }); }
  for (const n of gen.not_stated || []) u.push({ text: norm(n), unit: norm(n) });
  return u;
}
function intervals(text, needle) {
  const out = []; if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) { out.push([i, i + needle.length]); i = text.indexOf(needle, i + 1); }
  return out;
}
// positional overlap of two substrings within any generator text
function overlaps(texts, a, b) {
  a = norm(a); b = norm(b);
  if (a.includes(b) || b.includes(a)) return true;
  for (const t of texts) {
    const ia = intervals(t, a), ib = intervals(t, b);
    for (const [s1, e1] of ia) for (const [s2, e2] of ib) if (s1 < e2 && s2 < e1) return true;
  }
  return false;
}

// ── arithmetic / date checker for calculation strings ──
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_RE = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/;
function parseDate(s) {
  const m = norm(s).match(DATE_RE); if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase()); if (mi < 0) return null;
  return new Date(Date.UTC(+m[3], mi, +m[1]));
}
function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
function evalDate(expr) {
  const m = norm(expr).match(/^(\d{1,2} [A-Za-z]+ \d{4})((?: [+−-] \d+ (?:days?|months?))+)$/);
  if (!m) return null;
  let d = parseDate(m[1]); if (!d) return null;
  for (const op of m[2].matchAll(/([+−-]) (\d+) (days?|months?)/g)) {
    const n = (op[1] === "+" ? 1 : -1) * +op[2];
    if (op[3].startsWith("day")) d = new Date(d.getTime() + n * 86400000); else d = addMonths(d, n);
  }
  return d;
}
function evalNum(expr) {
  let s = norm(expr).replace(/[£$€,]/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  s = s.replace(/(\d+(?:\.\d+)?)%/g, "($1/100)");
  if (!/^[\d\s.+\-*/()]+$/.test(s)) return null;
  try { return Function(`"use strict";return (${s});`)(); } catch { return null; }
}
function checkCalc(c) { // returns true (correct), false (incorrect), null (unparseable)
  const d = evalDate(c.expression);
  if (d) { const r = parseDate(c.result); return r ? r.getTime() === d.getTime() : null; }
  const v = evalNum(c.expression), r = evalNum(c.result);
  if (v == null || r == null || !isFinite(v)) return null;
  return Math.abs(v - r) < 0.005;
}

// ── cases ──
const ids = new Set();
const counts = {};
for (const cs of data.cases || []) {
  const W = `case ${cs.id}`;
  if (!cs.id || ids.has(cs.id)) err(W, "missing or duplicate id"); ids.add(cs.id);
  if (!agText.has(cs.agreement)) { err(W, `unknown agreement ${cs.agreement}`); continue; }
  if (typeof cs.question !== "string" || !cs.question.trim()) err(W, "question required");
  if (cs.history !== undefined && (!Array.isArray(cs.history) || cs.history.some((h) => typeof h.question !== "string" || typeof h.answer !== "string")))
    err(W, "history must be [{question, answer}]");
  if (!["wrong", "control"].includes(cs.arm)) err(W, "bad arm");
  if (cs.arm === "control" && cs.errorType !== "control") err(W, "control arm must have errorType control");
  if (cs.arm === "wrong" && !ERROR_TYPES.includes(cs.errorType)) err(W, `bad errorType ${cs.errorType}`);
  const key = `${cs.arm}/${cs.errorType}`; counts[key] = (counts[key] || 0) + 1;

  const gen = cs.generator || {};
  if (!STATUSES.includes(gen.status)) err(W, "bad generator.status");
  for (const f of ["answer", "explanation"]) if (typeof gen[f] !== "string") err(W, `generator.${f} must be a string`);
  if (!Array.isArray(gen.calculations) || gen.calculations.some((c) => typeof c.expression !== "string" || typeof c.result !== "string")) err(W, "bad calculations");
  if (!Array.isArray(gen.not_stated) || gen.not_stated.some((n) => typeof n !== "string")) err(W, "bad not_stated");
  if (!Array.isArray(gen.citations)) err(W, "citations must be an array");
  for (const ci of gen.citations || []) {
    if (ci.passage !== "auto") err(W, "citation passage must be 'auto'");
    if (!onSomePage(cs.agreement, ci.quote)) err(W, `citation quote not verbatim: "${ci.quote}"`);
  }
  const texts = genTexts(gen);
  const inGen = (s) => texts.some((t) => t.includes(norm(s)));

  // calculation correctness by arm
  const calcResults = (gen.calculations || []).map(checkCalc);
  if (cs.arm === "control" && calcResults.some((r) => r !== true)) err(W, `control calculation not verifiably correct: ${JSON.stringify(calcResults)}`);
  if (["wrong_arithmetic", "wrong_date"].includes(cs.errorType) && !calcResults.some((r) => r === false)) err(W, "expected at least one arithmetically wrong calculation");
  if (cs.errorType === "laundered_calc" && (calcResults.length === 0 || calcResults.some((r) => r !== true))) err(W, "laundered_calc calculations must be arithmetically correct");

  // verifier outputs
  for (const which of ["honest", "fooled"]) {
    const claims = cs.verifier?.[which]?.claims;
    if (!Array.isArray(claims) || claims.length === 0) { err(W, `${which}.claims must be a non-empty array`); continue; }
    for (const [i, c] of claims.entries()) {
      const C = `${W} ${which}[${i}]`;
      if (typeof c.span !== "string" || !c.span.trim() || !inGen(c.span)) err(C, `span not verbatim in generator output: "${c.span}"`);
      if (typeof c.claim !== "string" || !c.claim.trim()) err(C, "claim required");
      if (!KINDS.includes(c.kind)) err(C, `bad kind ${c.kind}`);
      if (typeof c.material !== "boolean") err(C, "material must be boolean");
      if (!VERDICTS.includes(c.verdict)) err(C, `bad verdict ${c.verdict}`);
      if (typeof c.reason !== "string") err(C, "reason required");
      if (!Array.isArray(c.evidence)) { err(C, "evidence must be an array"); continue; }
      for (const e of c.evidence) {
        if (e.passage !== "auto") err(C, "evidence passage must be 'auto'");
        if (typeof e.quote !== "string" || norm(e.quote).length < 10) err(C, `evidence quote too short: "${e.quote}"`);
        else if (!onSomePage(cs.agreement, e.quote)) err(C, `evidence quote not verbatim: "${e.quote}"`);
      }
      if (c.kind === "absence" && c.verdict === "supported" && c.evidence.length) err(C, "supported absence claims carry no evidence");
      if (which === "honest" && c.verdict === "supported" && ["term", "context"].includes(c.kind) && !c.evidence.length) err(C, "honest supported term/context claim needs evidence");
    }
    if (which === "honest") {
      for (const u of units(gen)) if (!claims.some((c) => overlaps([u.text], c.span, u.unit) && (norm(u.unit).includes(norm(c.span)) || norm(c.span).includes(norm(u.unit)))))
        err(W, `honest verifier does not cover: "${u.unit}"`);
    }
  }

  const honest = cs.verifier?.honest?.claims || [], fooled = cs.verifier?.fooled?.claims || [];
  const wp = cs.wrongPhrases;
  if (!Array.isArray(wp)) { err(W, "wrongPhrases must be an array"); continue; }
  if (cs.arm === "control") {
    if (wp.length) err(W, "controls must have no wrongPhrases");
    if (honest.some((c) => c.verdict !== "supported")) err(W, "control honest claims must all be supported");
    if (JSON.stringify(honest) !== JSON.stringify(fooled)) err(W, "control fooled must equal honest");
    continue;
  }
  if (wp.length < 1) err(W, "wrong case needs >=1 wrongPhrases");
  if (JSON.stringify(honest) === JSON.stringify(fooled)) err(W, "fooled must differ from honest");
  if (!honest.some((c) => c.verdict !== "supported" && c.material)) err(W, "honest must flag a material claim");
  const controlTexts = (data.cases || []).filter((x) => x.arm === "control" && x.agreement === cs.agreement).flatMap((x) => genTexts(x.generator || {}));
  for (const p of wp) {
    const P = `${W} wrongPhrase "${p}"`;
    if (typeof p !== "string" || norm(p).length < 4 || GENERIC.has(norm(p).toLowerCase())) { err(P, "too short or generic"); continue; }
    if (!inGen(p)) err(P, "not verbatim in generator output");
    if (controlTexts.some((t) => t.includes(norm(p)))) err(P, "appears in a correct control answer for the same agreement");
    const hits = honest.filter((c) => overlaps(texts, c.span, p));
    if (!hits.length) err(P, "no honest claim covers it");
    if (!hits.some((c) => c.verdict !== "supported")) err(P, "honest verifier never rejects it");
    if (honest.some((c) => c.verdict === "supported" && norm(c.span).includes(norm(p)))) err(P, "honest marks a span containing it as supported");
    // fooled must let it through: every fooled claim touching it is supported (or nothing touches it)
    if (fooled.some((c) => overlaps(texts, c.span, p) && c.verdict !== "supported")) err(P, "fooled verifier still rejects it");
  }
}

// ── suite-level checks ──
for (const t of ERROR_TYPES) if ((counts[`wrong/${t}`] || 0) < 5) err("suite", `fewer than 5 cases of ${t}`);
if ((counts["control/control"] || 0) < 15) err("suite", "fewer than 15 controls");

const nWrong = (data.cases || []).filter((c) => c.arm === "wrong").length;
const nCtl = (data.cases || []).filter((c) => c.arm === "control").length;
console.log(`agreements: ${data.agreements.length}  cases: ${data.cases.length} (wrong ${nWrong}, control ${nCtl})`);
for (const t of [...ERROR_TYPES, "control"]) console.log(`  ${t.padEnd(24)} ${counts[t === "control" ? "control/control" : `wrong/${t}`] || 0}`);
if (errors.length) { console.log(`\nFAIL: ${errors.length} problem(s)`); for (const e of errors) console.log("  - " + e); process.exit(1); }
console.log("\nPASS: all checks satisfied");
