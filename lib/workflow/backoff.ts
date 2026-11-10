import type { RetryPolicy, Rng } from "./types";

/**
 * Delay before the next attempt, after `attempt` failed attempts (1-based): exponential, capped, with
 * "equal jitter" (half fixed, half random) so retries never fire early and don't stampede together.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, rng: Rng): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const r = Math.min(Math.max(rng(), 0), 0.999999999);
  return Math.floor(exp / 2 + r * (exp / 2));
}
