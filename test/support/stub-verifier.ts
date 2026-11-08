// Scripted verifiers for tests (no network): one that supports every claim with real evidence from the first
// binding passage, and one that returns whatever verdicts a test scripts.
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";

/** The answer under review, as the verifier sees it, split into sentence-sized claims. */
export function claimsOf(req: ModelRequest): string[] {
  const body = /<answer>([\s\S]*)<\/answer>/.exec(req.document)?.[1] ?? "";
  const text = body.replace(/<\/?(?:text|explanation|calculation|note)>/g, "\n");
  const out: string[] = [];
  for (const s of text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 3)) {
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
    return { claims: claimsOf(req).map((claim) => ({ claim, kind: "term", material: true, verdict: "supported", evidence: [ev], reason: "stub" })) };
  },
});

export const scripted = (verdicts: (req: ModelRequest) => unknown, calls: ModelRequest[] = []): ModelProvider => ({
  name: "stub-verifier",
  model: "claude-opus-5-5",
  complete: async (req) => {
    calls.push(req);
    return verdicts(req);
  },
});
