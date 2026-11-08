// What a model call costs, from the token counts the API reports. Used for the daily AI budget and the record of
// each question; amounts are integer micro-dollars so sums are exact. Prices are per million tokens.
import type { Usage } from "../understand/model";

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };
// Claude Opus 5.5: $4 input, $20 output, cache writes 1.25x input (5-minute cache), cache reads $0.20
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
/** Unknown models are costed at the most expensive configured price, so a budget is never undercounted. */
const FALLBACK: Price = Object.values(PRICES).reduce((a, p) => ({ input: Math.max(a.input, p.input), output: Math.max(a.output, p.output), cacheWrite: Math.max(a.cacheWrite, p.cacheWrite), cacheRead: Math.max(a.cacheRead, p.cacheRead) }));

export function costMicroUsd(model: string, u: Usage | undefined): number {
  if (!u) return 0;
  const p = PRICES[model] ?? FALLBACK;
  return Math.ceil(u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheWriteTokens ?? 0) * p.cacheWrite + (u.cacheReadTokens ?? 0) * p.cacheRead);
}

/** The most one question can cost: the whole input written to the cache, and every output token used. */
export function worstCaseMicroUsd(model: string, inputTokens: number, maxOutputTokens: number): number {
  const p = PRICES[model] ?? FALLBACK;
  return Math.ceil(inputTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output);
}
