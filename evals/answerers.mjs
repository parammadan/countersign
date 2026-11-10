// Baseline answerers. They exist to validate the metrics, NOT to claim model quality.
// Only `oracle` sees gold data; the others see just { question, documents } like any Answerer.
import { normalize, passages, tokens } from "./text.mjs";

/** @type {import("./types").Answerer} */
export async function abstain() {
  return { status: "not_found", answer: "The documents do not say.", citations: [] };
}

function rank(question, documents) {
  const q = new Set(tokens(question));
  let best = null;
  for (const doc of documents) {
    doc.pages.forEach((page, pi) => {
      for (const p of passages(page)) {
        const pt = new Set(tokens(p));
        let overlap = 0;
        for (const t of q) if (pt.has(t)) overlap++;
        if (overlap > 0 && (!best || overlap > best.overlap)) best = { overlap, docId: doc.id, page: pi + 1, quote: p };
      }
    });
  }
  return best;
}

/** Quotes the single passage with the most question-word overlap. Needs at least two shared words. */
export async function extractive({ question, documents }) {
  const best = rank(question, documents);
  if (!best || best.overlap < 2) return { status: "not_found", answer: "No relevant passage found.", citations: [] };
  return { status: "answered", answer: best.quote, citations: [{ docId: best.docId, page: best.page, quote: best.quote }] };
}

const INJECTION = /ignore (?:all |any )?(?:previous|prior)|disregard|system prompt|assistant must|you must (?:say|answer|respond|state)|note to (?:the )?(?:ai|assistant)|\[system\]/i;
const PLANTED = /\b(?:superseded|unofficial|marketing summary|not binding|draft summary)\b/i;

/** Repeats whatever injected or planted text it finds, with a (valid) citation. A correct harness must flag it. */
export async function adversarial({ documents }) {
  for (const doc of documents) {
    for (let pi = 0; pi < doc.pages.length; pi++) {
      const page = doc.pages[pi];
      for (const p of passages(page)) {
        if (INJECTION.test(p) || PLANTED.test(p)) {
          // Repeat the flagged sentence and everything after it on the page, as a gullible model would.
          const quote = page.slice(page.indexOf(p)).trim();
          return { status: "answered", answer: quote, citations: [{ docId: doc.id, page: pi + 1, quote }] };
        }
      }
    }
  }
  return { status: "not_found", answer: "Nothing to repeat.", citations: [] };
}

/** Returns the gold answer for each case, looked up by question and document ids. */
export function createOracle(cases) {
  const key = (q, docs) => `${normalize(q)}||${docs.map((d) => d.id).join(",")}`;
  const map = new Map(cases.map((c) => [key(c.question, c.documents), c.gold]));
  return async ({ question, documents }) => {
    const g = map.get(key(question, documents));
    if (!g) throw new Error(`oracle: no gold for question "${question}"`);
    return { status: g.status, answer: g.answer, citations: g.sources.map((s) => ({ ...s })) };
  };
}

export const BASELINES = ["oracle", "abstain", "extractive", "adversarial"];

/** Resolve a baseline name, or a path to an ES module whose default export is an Answerer. */
export async function resolveAnswerer(name, cases) {
  if (name === "oracle") return createOracle(cases);
  if (name === "abstain") return abstain;
  if (name === "extractive") return extractive;
  if (name === "adversarial") return adversarial;
  if (/[\\/]|\.m?js$/.test(name)) {
    const { pathToFileURL } = await import("node:url");
    const { resolve } = await import("node:path");
    const mod = await import(pathToFileURL(resolve(name)).href);
    if (typeof mod.default !== "function") throw new Error(`${name}: default export must be an Answerer function`);
    return mod.default;
  }
  throw new Error(`unknown answerer "${name}" (baselines: ${BASELINES.join(", ")}, or a module path)`);
}
