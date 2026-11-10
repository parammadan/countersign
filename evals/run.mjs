#!/usr/bin/env node
// Usage: node evals/run.mjs --answerer <oracle|abstain|extractive|adversarial|path/to/module.mjs> [--out file.json] [--dataset dir]
// Deterministic: fixed case order, no randomness, no clock, no network.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./dataset.mjs";
import { resolveAnswerer } from "./answerers.mjs";
import { scoreRun } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run an answerer over cases and score it. Exported for tests and for integration. */
export async function evaluate(answerer, cases) {
  const answers = [];
  for (const c of cases) {
    // Answerers get a copy with no gold data.
    const input = structuredClone({ question: c.question, documents: c.documents });
    let out;
    try {
      out = await answerer(input);
    } catch (e) {
      out = { status: "not_found", answer: "", citations: [], error: String(e?.message ?? e) };
    }
    answers.push({
      status: ["answered", "partial", "not_found"].includes(out?.status) ? out.status : "not_found",
      answer: typeof out?.answer === "string" ? out.answer : "",
      citations: Array.isArray(out?.citations) ? out.citations : [],
      ...(out?.error ? { error: out.error } : {}),
    });
  }
  return { ...scoreRun(cases, answers), answers };
}

const pct = (v) => (v === null ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

export function formatTable(name, overall, byCategory) {
  const cols = [
    ["cites", "citationAccuracy"], ["srcRec", "sourceRecall"], ["fPrec", "factualPrecision"], ["fRec", "factualRecall"],
    ["unsup", "unsupportedClaimRate"], ["absP", "abstentionPrecision"], ["absR", "abstentionRecall"], ["contra", "contradictionHandling"], ["trapLeak", "trapLeakRate"],
  ];
  const head = ["scope".padEnd(14), "cases".padStart(5), ...cols.map(([h]) => h.padStart(7))].join(" ");
  const line = (label, m) => [label.padEnd(14), String(m.cases).padStart(5), ...cols.map(([, k]) => pct(m[k]).padStart(7))].join(" ");
  const errs = overall.errors ? [`WARNING: ${overall.errors} case(s) threw; scored as errors, not abstentions`] : [];
  return [`answerer: ${name}`, ...errs, head, line("ALL", overall), ...Object.entries(byCategory).map(([k, m]) => line(k, m))].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const name = get("--answerer");
  if (!name) {
    console.error("usage: node evals/run.mjs --answerer <oracle|abstain|extractive|adversarial|module path> [--out file] [--dataset dir]");
    process.exit(2);
  }
  const cases = loadCases(get("--dataset"));
  const answerer = await resolveAnswerer(name, cases);
  const result = await evaluate(answerer, cases);
  const label = /[\\/]/.test(name) ? name.split(/[\\/]/).pop() : name;
  const out = get("--out") ?? join(HERE, "results", `${label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ answerer: label, overall: result.overall, byCategory: result.byCategory, rows: result.rows, answers: result.answers }, null, 2) + "\n");
  console.log(formatTable(label, result.overall, result.byCategory));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
