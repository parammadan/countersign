// Scripted verifiers for tests (no network): one that supports every claim with real evidence from the first
// binding passage, and one that returns whatever verdicts a test scripts.
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";
import { numbersIn } from "@/lib/qa/numbers";

/** The answer under review, as the verifier sees it, split into sentence-sized claims (each its own span). */
export function claimsOf(req: ModelRequest): string[] {
  // the answer under review is the last <answer> block (earlier turns have their own)
  const d = req.document;
  const body = d.includes("</answer>") ? d.slice(d.lastIndexOf("<answer>") + "<answer>".length, d.lastIndexOf("</answer>")) : "";
  const text = body.replace(/<\/?(?:text|explanation|calculation|note)>/g, "\n");
  const out: string[] = [];
  const parts = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  // a bare "Yes." or "No." is judged with the sentence it answers for
  for (let i = 0; i < parts.length - 1; i++) if (/^(?:yes|no)[.!,]?$/i.test(parts[i])) parts.splice(i, 2, `${parts[i]} ${parts[i + 1]}`);
  for (const s of parts.filter((x) => x.length >= 3)) {
    for (let i = 0; i < s.length; i += 480) out.push(s.slice(i, i + 480));
  }
  return out.length ? out : ["(empty answer)"];
}

export function firstBindingEvidence(req: ModelRequest): { passage: string; quote: string } {
  const m = /<passage id="(p[^"]+)" page="\d+">([^<]{8,})/.exec(req.context ?? "");
  if (!m) throw new Error("no binding passage");
  return { passage: m[1], quote: m[2].slice(0, 60).trim() };
}

/**
 * Evidence for a claim as a careful verifier gives it: for each figure the claim states, a sentence of a binding
 * passage that has it (none if no passage does); for a claim without figures, the first binding passage.
 */
export function evidenceFor(req: ModelRequest, claim: string): { passage: string; quote: string }[] {
  // binding passages first; text labelled not binding only for a claim about that text
  const all = [...(req.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+"( binding="false")?>([^<]*)<\/passage>/g)].map((m) => ({ id: m[1], text: m[3], binding: !m[2] }));
  const ps = [...all.filter((p) => p.binding), ...(ABOUT_ASIDE.test(claim) ? all.filter((p) => !p.binding) : [])];
  const out: { passage: string; quote: string }[] = [];
  for (const n of numbersIn(claim)) {
    let hit: { passage: string; quote: string } | null = null;
    let best = -1;
    for (const p of ps) {
      // sentences, and the phrases of long ones (a quote is at most 400 characters)
      const pieces = p.text
        .split(/(?<=[.!?;])\s+/)
        .flatMap((x) => (x.length > 400 ? x.split(/,\s+/) : [x]))
        .flatMap((x) => (x.length > 400 ? (x.match(/[\s\S]{1,300}(?:\s|$)/g) ?? []) : [x]))
        .map((x) => x.trim());
      // of the pieces with the figure, the one sharing most words with the claim
      for (const sentence of pieces) {
        if (sentence.length < 8 || sentence.length > 400 || !numbersIn(sentence).has(n)) continue;
        const score = overlap(sentence, claim);
        if (!hit || score > best) { hit = { passage: p.id, quote: sentence }; best = score; }
      }
    }
    if (hit && !out.some((e) => e.quote === hit!.quote)) out.push(hit);
  }
  return (out.length ? out : [firstBindingEvidence(req)]).slice(0, 6);
}

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4));
const overlap = (a: string, b: string) => { const wb = words(b); return [...words(a)].filter((w) => wb.has(w)).length; };
const ABOUT_ASIDE = /\b(?:not binding|non-binding|nonbinding|not part of|does not form part|superseded|withdrawn|no contractual effect|no legal effect)\b/i;
/** The question the answer is for (the last <question> block). */
const questionOf = (req: ModelRequest) => [...req.document.matchAll(/<question>([\s\S]*?)<\/question>/g)].at(-1)?.[1] ?? "";

/**
 * A verifier that supports every sentence of the answer, as a careful one would: quoting the clauses that hold its
 * figures, judging a disclaimer of text labelled not binding as context, and restating what a "Yes" or "No" answers.
 */
export const approveAll = (calls: ModelRequest[] = []): ModelProvider => ({
  name: "stub-verifier",
  model: "claude-opus-5-5",
  complete: async (req) => {
    calls.push(req);
    return {
      claims: claimsOf(req).map((span) => {
        // a note says what the agreement doesn't say; the real verifier restates it that way
        const notes = [...req.document.matchAll(/<note>([\s\S]*?)<\/note>/g)].map((m) => m[1].replace(/‹/g, "<").replace(/›/g, ">"));
        if (notes.some((x) => x.includes(span) || span.includes(x))) {
          const claim = `The agreement does not say ${span.charAt(0).toLowerCase()}${span.slice(1)}`;
          return numbersIn(span).size
            ? { span, claim, kind: "absence", material: true, verdict: "supported", evidence: evidenceFor(req, span), reason: "stub" }
            : { span, claim, kind: "absence", material: true, verdict: "supported", evidence: [], reason: "stub" };
        }
        const claim = /^(?:yes|no)(?:[.,!:;]|\s*$)/i.test(span) ? `${span} (in answer to: ${questionOf(req)})` : span;
        const evidence = evidenceFor(req, span);
        const unofficial = new Set([...(req.context ?? "").matchAll(/<passage id="(p[^"]+)" page="\d+" binding="false">/g)].map((m) => m[1]));
        const aside = ABOUT_ASIDE.test(span) && evidence.some((e) => unofficial.has(e.passage));
        return { span, claim, kind: aside ? "context" : "term", material: true, verdict: "supported", evidence, reason: "stub" };
      }),
    };
  },
});

/** Scripted verdicts; a claim with no `span` gets its own text as the span (an explicit "" stays empty). */
export const scripted = (verdicts: (req: ModelRequest) => unknown, calls: ModelRequest[] = []): ModelProvider => ({
  name: "stub-verifier",
  model: "claude-opus-5-5",
  complete: async (req) => {
    calls.push(req);
    const out = verdicts(req) as { claims?: { claim?: string; span?: string }[] };
    if (out && typeof out === "object" && Array.isArray(out.claims)) out.claims = out.claims.map((c) => (c && typeof c === "object" && c.span === undefined ? { ...c, span: c.claim } : c));
    return out;
  },
});
