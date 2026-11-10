// HMAC-SHA256 signing of outgoing payloads: header `t=<unix seconds>,v1=<hex>` over `${t}.${body}`.
import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-workflow-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;
/** Shortest signing secret accepted anywhere (signer, verifier, outbox). An empty or short secret is a forgery waiting to happen. */
export const MIN_SECRET_LENGTH = 32;

/** Throws unless `secret` is a string of at least MIN_SECRET_LENGTH characters. */
export function assertSigningSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) throw new Error(`signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
}

/**
 * The `idempotency-key` header value: the tenant's key scoped to its workspace, so two workspaces that chose the
 * same key and send to one receiver never collide. Not a secret (anyone can recompute it from the signed body);
 * it is unambiguous because both parts are JSON-encoded before hashing.
 */
export function scopedIdempotencyKey(workspaceId: string, idempotencyKey: string): string {
  const h = crypto.createHmac("sha256", "agreementos.workflow.idempotency-key.v1").update(JSON.stringify([workspaceId, idempotencyKey])).digest("hex");
  return `ik1_${h}`;
}

function mac(secret: string, t: number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

export function signPayload(secret: string, body: string, nowMs: number): string {
  assertSigningSecret(secret);
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${mac(secret, t, body)}`;
}

export type VerifyFailure = "malformed" | "bad_signature" | "stale" | "future" | "invalid_secret";
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Like verifySignature, but also returns the signed timestamp (seconds) on success. */
export function checkSignature(
  secrets: string | readonly string[],
  body: string,
  header: string | null | undefined,
  nowMs: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): { ok: true; timestamp: number } | { ok: false; reason: VerifyFailure } {
  const list: readonly unknown[] = Array.isArray(secrets) ? secrets : [secrets];
  if (list.length === 0 || list.some((s) => typeof s !== "string" || s.trim().length < MIN_SECRET_LENGTH)) return { ok: false, reason: "invalid_secret" };
  if (!header || typeof header !== "string") return { ok: false, reason: "malformed" };
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) return { ok: false, reason: "malformed" };
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === null || sigs.length === 0) return { ok: false, reason: "malformed" };
  let match = false;
  for (const secret of list as string[]) {
    const expected = Buffer.from(mac(secret, t, body), "hex");
    for (const s of sigs) {
      if (crypto.timingSafeEqual(expected, Buffer.from(s, "hex"))) match = true;
    }
  }
  if (!match) return { ok: false, reason: "bad_signature" };
  const nowS = Math.floor(nowMs / 1000);
  if (nowS - t > toleranceSeconds) return { ok: false, reason: "stale" };
  if (t - nowS > toleranceSeconds) return { ok: false, reason: "future" };
  return { ok: true, timestamp: t };
}

/**
 * Low-level check of a signature header over the body only. `secrets` may hold several values so a secret can be
 * rotated; any match passes. Rejects timestamps older than the tolerance (replay) and further in the future than
 * the tolerance (clock abuse), and refuses to verify at all with an empty or short secret.
 *
 * Not a receiver on its own: it is stateless (a captured request verifies again inside the window) and it does
 * not look at headers, so the `x-workflow-event-id`, `x-workflow-delivery-id` and `idempotency-key` headers are
 * NOT covered by it. Receivers must use `WebhookVerifier` (`receive`, or `verify` plus their own dedupe), which adds
 * the replay cache, binds every id header to the signed body, and dedupes on the signed event id. Never dedupe
 * on a header value.
 */
export function verifySignature(
  secrets: string | readonly string[],
  body: string,
  header: string | null | undefined,
  nowMs: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  const r = checkSignature(secrets, body, header, nowMs, toleranceSeconds);
  return r.ok ? { ok: true } : r;
}
