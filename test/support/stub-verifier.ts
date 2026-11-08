// Scripted verifiers for tests (no network): one that supports every claim with real evidence from the first
// binding passage, and one that returns whatever verdicts a test scripts.
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";

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

export const approveAll = (calls: ModelRequest[] = []): ModelProvider => ({
  name: "stub-verifier",
  model: "claude-opus-5-5",
  complete: async (req) => {
    calls.push(req);
    const ev = firstBindingEvidence(req);
    return { claims: claimsOf(req).map((claim) => ({ span: claim, claim, kind: "term", material: true, verdict: "supported", evidence: [ev], reason: "stub" })) };
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
