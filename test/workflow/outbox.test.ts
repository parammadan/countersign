import { describe, it, expect, afterEach } from "vitest";
import { IdempotencyConflictError, SIGNATURE_HEADER, verifySignature } from "../../lib/workflow";
import { OPERATOR, SECRET, evt, setup, target } from "./helpers";

let ctx: ReturnType<typeof setup>;
afterEach(() => ctx?.cleanup());

describe("publish and idempotency", () => {
  it("stores the event with id, scope, type and payload hash, and one delivery per target", () => {
    ctx = setup();
    const r = ctx.outbox.publish(evt(), [target, { id: "ep_2", url: "https://b.example.test/in" }]);
    expect(r.duplicate).toBe(false);
    expect(r.event).toMatchObject({ id: "evt_1", workspaceId: "ws_a", type: "file.signed" });
    expect(r.event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.deliveries).toHaveLength(2);
  });
  it("publishing the same key twice queues and sends once", async () => {
    ctx = setup();
    const a = ctx.outbox.publish(evt(), [target]);
    const b = ctx.outbox.publish(evt(), [target]);
    expect(b.duplicate).toBe(true);
    expect(b.event.id).toBe(a.event.id);
    await ctx.outbox.runDue();
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(1);
  });
  it("rejects a reused key with a different payload", () => {
    ctx = setup();
    ctx.outbox.publish(evt(), [target]);
    expect(() => ctx.outbox.publish(evt({ payload: { other: true } }), [target])).toThrow(IdempotencyConflictError);
  });
  it("scopes keys by workspace", () => {
    ctx = setup();
    const a = ctx.outbox.publish(evt(), [target]);
    const b = ctx.outbox.publish(evt({ workspaceId: "ws_b" }), [target]);
    expect(b.duplicate).toBe(false);
    expect(b.event.id).not.toBe(a.event.id);
  });
  it("consumer processes a twice-delivered event once, and retries after a handler failure", async () => {
    ctx = setup();
    let n = 0;
    expect(await ctx.outbox.processOnce("ws_a", "evt_1", "mailer", () => { n++; })).toBe("processed");
    expect(await ctx.outbox.processOnce("ws_a", "evt_1", "mailer", () => { n++; })).toBe("duplicate");
    expect(n).toBe(1);
    await expect(ctx.outbox.processOnce("ws_a", "evt_2", "mailer", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await ctx.outbox.processOnce("ws_a", "evt_2", "mailer", () => { n++; })).toBe("processed");
    expect(n).toBe(2);
  });
});

describe("delivery", () => {
  it("sends a verifiable signed request and audits success", async () => {
    ctx = setup();
    const { deliveries } = ctx.outbox.publish(evt(), [target]);
    const s = await ctx.outbox.runDue();
    expect(s).toMatchObject({ attempted: 1, delivered: 1 });
    const req = ctx.transport.requests[0];
    expect(req.url).toBe(target.url);
    expect(verifySignature(SECRET, req.body, req.headers[SIGNATURE_HEADER], ctx.clock.now())).toEqual({ ok: true });
    expect(req.headers["x-workflow-event-id"]).toBe("evt_1");
    expect(JSON.parse(req.body).data).toEqual({ fileId: "file_1", client: "Jordan Sample" });
    expect(ctx.outbox.getDelivery("ws_a", deliveries[0].id)?.status).toBe("delivered");
    expect(ctx.outbox.audit("ws_a")).toMatchObject([{ outcome: "delivered", statusCode: 200, attempt: 1 }]);
  });

  it("retries 5xx, timeouts and network errors on a deterministic backoff schedule, then succeeds", async () => {
    ctx = setup();
    const { deliveries } = ctx.outbox.publish(evt(), [target]);
    const id = deliveries[0].id;
    ctx.transport.script({ status: 503 }, "timeout", "network", { status: 200 });
    const t0 = ctx.clock.now();
    await ctx.outbox.runDue();
    // rng 0.5: delay = floor(e/2 + 0.5*e/2) = 0.75*e with e = 1000, 2000, 4000
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: t0 + 750 });
    await ctx.outbox.runDue(); // not due yet
    expect(ctx.transport.requests).toHaveLength(1);
    ctx.clock.advance(749);
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(1);
    ctx.clock.advance(1);
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ attempts: 2, nextAttemptAt: ctx.clock.now() + 1500, lastError: "timeout" });
    ctx.clock.advance(1500);
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ attempts: 3, nextAttemptAt: ctx.clock.now() + 3000 });
    ctx.clock.advance(3000);
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)?.status).toBe("delivered");
    expect(ctx.outbox.audit("ws_a", id).map((a) => a.outcome)).toEqual(["retry_scheduled", "retry_scheduled", "retry_scheduled", "delivered"]);
    expect(ctx.outbox.audit("ws_a", id).map((a) => a.statusCode)).toEqual([503, null, null, 200]);
  });

  it("retries 429 and 408 but dead-letters other 4xx immediately", async () => {
    ctx = setup();
    const a = ctx.outbox.publish(evt({ idempotencyKey: "a" }), [target]).deliveries[0].id;
    ctx.transport.script({ status: 429 });
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", a)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: ctx.clock.now() + 750 });
    const b = ctx.outbox.publish(evt({ idempotencyKey: "b" }), [{ id: "ep_9", url: "https://c.example.test/" }]).deliveries[0].id;
    ctx.clock.advance(10_000);
    ctx.transport.script({ status: 408 }, { status: 200 }); // b (never attempted, due earlier) gets 408, then a succeeds
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", a)?.status).toBe("delivered");
    expect(ctx.outbox.getDelivery("ws_a", b)).toMatchObject({ status: "pending", attempts: 1, lastError: "http 408" });
    const c = ctx.outbox.publish(evt({ idempotencyKey: "c" }), [{ id: "ep_8", url: "https://d.example.test/" }]).deliveries[0].id;
    ctx.transport.script({ status: 410 });
    await ctx.outbox.runDue();
    expect(ctx.transport.requests.at(-1)?.url).toBe("https://d.example.test/");
    const dead = ctx.outbox.getDelivery("ws_a", c)!;
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(1);
    expect(dead.deadReason).toContain("permanent failure");
  });

  it("dead-letters after maxAttempts with a reason and never tries again", async () => {
    ctx = setup();
    ctx.transport.setFallback({ status: 500 });
    const { deliveries } = ctx.outbox.publish(evt(), [target]);
    for (let i = 0; i < 10; i++) {
      await ctx.outbox.runDue();
      ctx.clock.advance(120_000);
    }
    expect(ctx.transport.requests).toHaveLength(4);
    const d = ctx.outbox.getDelivery("ws_a", deliveries[0].id)!;
    expect(d).toMatchObject({ status: "dead", attempts: 4 });
    expect(d.deadReason).toContain("max attempts (4) exceeded");
    expect(ctx.outbox.deadLetters("ws_a").map((x) => x.id)).toEqual([d.id]);
    expect(ctx.outbox.deadLetters("ws_b")).toEqual([]);
    expect(ctx.outbox.audit("ws_a").at(-1)?.outcome).toBe("dead_lettered");
  });

  it("replay re-queues a dead delivery with a fresh budget, audits the operator, and is workspace-scoped", async () => {
    ctx = setup();
    ctx.transport.setFallback({ status: 500 });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    for (let i = 0; i < 6; i++) {
      await ctx.outbox.runDue();
      ctx.clock.advance(120_000);
    }
    expect(() => ctx.outbox.replay("ws_b", id, OPERATOR)).toThrow(/dead-letter/);
    expect(() => ctx.outbox.replay("ws_a", id, " ")).toThrow(/replay denied/);
    ctx.transport.setFallback({ status: 200 });
    ctx.outbox.replay("ws_a", id, OPERATOR);
    expect(() => ctx.outbox.replay("ws_a", id, OPERATOR)).toThrow(); // no longer dead
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "delivered", attempts: 1, deadReason: null });
    const outcomes = ctx.outbox.audit("ws_a", id);
    expect(outcomes.map((a) => a.outcome).slice(-3)).toEqual(["replayed", "replay_denied", "delivered"]);
    expect(outcomes.at(-2)).toMatchObject({ actor: "op_avery", error: "delivery is not dead-lettered" });
    expect(outcomes.find((a) => a.outcome === "replay_denied")).toMatchObject({ actor: null, error: "unauthenticated" });
    expect(outcomes.find((a) => a.outcome === "replayed")?.actor).toBe("op_avery");
  });

  it("a runner whose lease expired cannot overwrite the runner that took over", async () => {
    ctx = setup({ leaseMs: 5000, timeoutMs: 1000 });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    const releases: Array<() => void> = [];
    const results: number[] = [500, 200]; // first (stale) runner would report 500, the takeover 200
    ctx.transport.send = async (req) => {
      ctx.transport.requests.push(req);
      const status = results.shift()!;
      await new Promise<void>((r) => releases.push(r));
      return { status, remoteAddress: req.address };
    };
    const stale = ctx.outbox.runDue();
    await new Promise((r) => setTimeout(r, 5));
    expect((await ctx.outbox.runDue()).attempted).toBe(0); // lease still held
    ctx.clock.advance(5000);
    const takeover = ctx.outbox.runDue();
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.transport.requests).toHaveLength(2);
    expect(ctx.transport.requests[1].headers["x-workflow-attempt"]).toBe("2");
    releases[1](); // takeover finishes first: delivered
    await takeover;
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "delivered", attempts: 2 });
    releases[0](); // stale runner finishes late with a 500
    await stale;
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "delivered", attempts: 2, lastError: null });
    const audit = ctx.outbox.audit("ws_a", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "delivered", attempt: 2 });
  });

  it("dead-letters a delivery whose runner keeps dying mid-send instead of retaking it forever", async () => {
    ctx = setup({ leaseMs: 5000, timeoutMs: 1000, policy: { maxAttempts: 2 } });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    ctx.transport.send = () => new Promise(() => {}); // never resolves; the timeout is bypassed by abandoning the runner
    for (let i = 0; i < 2; i++) {
      void ctx.outbox.runDue(); // runner "crashes": its promise is abandoned
      await new Promise((r) => setTimeout(r, 5));
      ctx.clock.advance(5000);
    }
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "in_flight", attempts: 2 });
    expect((await ctx.outbox.runDue()).deadLettered).toBe(1);
    const d = ctx.outbox.getDelivery("ws_a", id)!;
    expect(d.status).toBe("dead");
    expect(d.attempts).toBe(2);
    expect(d.deadReason).toContain("lease expired");
    expect(ctx.outbox.audit("ws_a", id).at(-1)).toMatchObject({ outcome: "dead_lettered", error: "lease expired" });
  });

  it("enforces the timeout on a send that never resolves", async () => {
    ctx = setup({ timeoutMs: 20, leaseMs: 5000 });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    ctx.transport.send = () => new Promise(() => {});
    const s = await ctx.outbox.runDue();
    expect(s.retryScheduled).toBe(1);
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "pending", lastError: "timeout" });
  });

  it("retries when the signing secret is unavailable instead of sending unsigned", async () => {
    let secret: string | undefined = SECRET;
    ctx = setup({ secretFor: () => secret });
    ctx.outbox.publish(evt(), [target]);
    secret = undefined; // e.g. removed from the secret store after publish
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(0);
    expect(ctx.outbox.audit("ws_a")[0]).toMatchObject({ outcome: "retry_scheduled", error: "signing secret unavailable" });
  });
});

describe("audit hygiene", () => {
  it("never stores the payload, the signing secret or bearer tokens", async () => {
    ctx = setup();
    ctx.transport.send = async () => {
      throw new Error(`upstream said Bearer abc.def.ghi and echoed ${SECRET} ${"x".repeat(500)}`);
    };
    const { deliveries } = ctx.outbox.publish(evt({ payload: { ssn: "000-00-0000-FAKE", client: "Jordan Sample" } }), [target]);
    await ctx.outbox.runDue();
    const dump = JSON.stringify([ctx.outbox.audit("ws_a"), ctx.outbox.getDelivery("ws_a", deliveries[0].id)]);
    for (const needle of [SECRET, "abc.def.ghi", "000-00-0000-FAKE", "Jordan Sample"]) expect(dump).not.toContain(needle);
    const rec = ctx.outbox.audit("ws_a")[0];
    expect(rec.error!.length).toBeLessThanOrEqual(201);
    expect(rec.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("nextDueAt reports the earliest waiting delivery", async () => {
    ctx = setup();
    expect(ctx.outbox.nextDueAt()).toBeNull();
    ctx.outbox.publish(evt(), [target]);
    expect(ctx.outbox.nextDueAt()).toBe(ctx.clock.now());
    ctx.transport.script({ status: 500 });
    await ctx.outbox.runDue();
    expect(ctx.outbox.nextDueAt()).toBe(ctx.clock.now() + 750);
  });
});

describe("validation and scoping", () => {
  it("same key and payload with a different type is a conflict", () => {
    ctx = setup();
    ctx.outbox.publish(evt(), [target]);
    expect(() => ctx.outbox.publish(evt({ type: "file.voided" }), [target])).toThrow(IdempotencyConflictError);
  });
  it("hashes Date payloads by value", () => {
    ctx = setup();
    const a = ctx.outbox.publish(evt({ idempotencyKey: "d1", payload: { at: new Date(0) } }), [target]);
    const b = ctx.outbox.publish(evt({ idempotencyKey: "d2", payload: { at: new Date(1000) } }), [target]);
    expect(a.event.payloadHash).not.toBe(b.event.payloadHash);
    expect(a.event.payload).toEqual({ at: "1970-01-01T00:00:00.000Z" });
  });
  it("rejects idempotency keys that could break a header", () => {
    ctx = setup();
    for (const k of ["", "a b", "a\r\nx-evil: 1", "x".repeat(201)]) expect(() => ctx.outbox.publish(evt({ idempotencyKey: k }), [target])).toThrow(/idempotencyKey/);
  });
  it("rejects unsafe policy values, including explicit undefined falling back to defaults", () => {
    expect(() => setup({ policy: { maxAttempts: 0 } })).toThrow(/positive/);
    expect(() => setup({ policy: { baseDelayMs: NaN } })).toThrow(/positive/);
    expect(() => setup({ leaseMs: 1000, timeoutMs: 1000 })).toThrow(/leaseMs/);
    ctx = setup({ policy: { maxAttempts: undefined } });
    expect(ctx.outbox).toBeDefined();
  });
  it("audit and getDelivery do not leak across workspaces", async () => {
    ctx = setup();
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_b", id)).toBeNull();
    expect(ctx.outbox.audit("ws_b")).toEqual([]);
    expect(ctx.outbox.audit("ws_b", id)).toEqual([]);
  });
  it("redacts a secret that has no recognisable prefix, and url query strings", async () => {
    const plain = "plainsecretvalue1234567890abcdefgh";
    ctx = setup({ secretFor: () => plain });
    ctx.transport.send = async () => {
      throw new Error(`failed https://user:pw@hooks.example.test/in?token=abc123 with ${plain}`);
    };
    ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    const err = ctx.outbox.audit("ws_a")[0].error!;
    expect(err).not.toContain(plain);
    expect(err).not.toContain("abc123");
    expect(err).not.toContain("pw@");
  });
});
