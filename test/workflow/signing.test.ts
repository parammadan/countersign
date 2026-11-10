import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../../lib/workflow/signing";
import { backoffDelay } from "../../lib/workflow/backoff";
import { payloadHash } from "../../lib/workflow/canonical";

const NOW = Date.UTC(2026, 0, 1);
const S1 = "s1-test-secret-0123456789abcdefghij";
const OTHER = "other-test-secret-0123456789abcdefg";
const OLD = "old-test-secret-0123456789abcdefghi";
const NEW = "new-test-secret-0123456789abcdefghi";

describe("signing", () => {
  it("round-trips", () => {
    const h = signPayload(S1, '{"a":1}', NOW);
    expect(verifySignature(S1, '{"a":1}', h, NOW)).toEqual({ ok: true });
  });
  it("rejects a tampered body or wrong secret", () => {
    const h = signPayload(S1, '{"a":1}', NOW);
    expect(verifySignature(S1, '{"a":2}', h, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifySignature(OTHER, '{"a":1}', h, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects a replay outside the window and a far-future timestamp", () => {
    const h = signPayload(S1, "x", NOW);
    expect(verifySignature(S1, "x", h, NOW + 299_000)).toEqual({ ok: true });
    expect(verifySignature(S1, "x", h, NOW + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(S1, "x", h, NOW - 301_000)).toEqual({ ok: false, reason: "future" });
  });
  it("cannot move the timestamp without breaking the signature", () => {
    const h = signPayload(S1, "x", NOW).replace(/t=\d+/, `t=${Math.floor(NOW / 1000) + 5}`);
    expect(verifySignature(S1, "x", h, NOW).ok).toBe(false);
  });
  it("accepts either secret during rotation", () => {
    const h = signPayload(OLD, "x", NOW);
    expect(verifySignature([NEW, OLD], "x", h, NOW).ok).toBe(true);
  });
  it("accepts exactly the tolerance and any one valid v1 among several", () => {
    const h = signPayload(S1, "x", NOW);
    expect(verifySignature(S1, "x", h, NOW + 300_000).ok).toBe(true);
    expect(verifySignature(S1, "x", h, NOW - 300_000).ok).toBe(true);
    expect(verifySignature(S1, "x", `${h},v1=${"0".repeat(64)}`, NOW).ok).toBe(true);
  });
  it("rejects malformed headers", () => {
    for (const h of [undefined, "", "garbage", "t=abc,v1=00", `t=1,v1=${"z".repeat(64)}`, "v1=" + "0".repeat(64)])
      expect(verifySignature(S1, "x", h, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("backoff", () => {
  const p = { maxAttempts: 9, baseDelayMs: 1000, maxDelayMs: 8000 };
  it("grows exponentially, is capped, and jitter stays in [half, full]", () => {
    expect(backoffDelay(1, p, () => 0)).toBe(500);
    expect(backoffDelay(1, p, () => 0.999)).toBe(999);
    expect(backoffDelay(3, p, () => 0)).toBe(2000);
    expect(backoffDelay(4, p, () => 0)).toBe(4000);
    expect(backoffDelay(10, p, () => 0.5)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(10, p, () => 0.5)).toBe(6000);
  });
});

describe("payload hash", () => {
  it("ignores key order and differs on content", () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});
