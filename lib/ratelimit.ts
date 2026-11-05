// Small in-memory fixed-window limiter. One app instance, so this is enough.
const buckets = new Map<string, { n: number; reset: number }>();

export function limited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) {
    buckets.set(key, { n: 1, reset: t + windowMs });
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
    return false;
  }
  b.n++;
  return b.n > max;
}

// Only trust forwarding headers set by a proxy we sit behind (TRUST_PROXY=fly on Fly.io, =1 for a
// generic proxy that sets X-Forwarded-For). Otherwise a client could spoof its IP into the audit trail.
export function clientIp(h: Headers): string {
  const trust = process.env.TRUST_PROXY;
  if (trust === "fly") return (h.get("fly-client-ip") || "unknown").trim();
  if (trust === "1" || trust === "true") return (h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "unknown").trim();
  return "unknown";
}
