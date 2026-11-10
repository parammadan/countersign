// Defences for the S11 red-team findings still open after PR #61 (W1 remainder, W4, W5). Each "defence:" test
// fails on fix/S16-security e2d4d27 and passes here. Fake resolver and in-memory or scripted transports only:
// nothing here performs a DNS lookup or a network request.
import { describe, it, expect, afterEach } from "vitest";
import {
  IdempotencyConflictError,
  MAX_PAYLOAD_BYTES,
  MemoryTransport,
  SIGNATURE_HEADER,
  TRANSPORT_CONTRACT,
  WebhookVerifier,
  canonicalJson,
  isInMemoryTransport,
  payloadHash,
  scopedIdempotencyKey,
  signPayload,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type VerifiedEvent,
} from "../../lib/workflow";
import { PUBLIC_IP, SECRET, evt, fakeResolver, setup, target } from "./helpers";

const opened: ReturnType<typeof setup>[] = [];
const make = (over: Parameters<typeof setup>[0] = {}) => {
  const c = setup(over);
  opened.push(c);
  return c;
};
afterEach(() => {
  while (opened.length) opened.pop()!.cleanup();
});

/** A stand-in for a future network transport: records requests, answers from a script. Never touches the network. */
function scriptedNetwork(answer: (req: TransportRequest) => TransportResponse = (req) => ({ status: 200, remoteAddress: req.address })) {
  const requests: TransportRequest[] = [];
  const t: Transport & { requests: TransportRequest[] } = {
    contract: TRANSPORT_CONTRACT,
    requests,
    async send(req) {
      requests.push(req);
      return answer(req);
    },
  };
  return t;
}

async function deliveredOnce(c: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  c.outbox.publish(evt(over), [target]);
  await c.outbox.runDue();
  return c.transport.requests.at(-1)!;
}

describe("W4: receivers dedupe on the signed event id, never on a header", () => {
  it("defence: receive() runs a captured request once; a re-send is refused as replayed and forged dedupe headers are refused", async () => {
    const c = make();
    const sent = await deliveredOnce(c);
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    const seen: VerifiedEvent[] = [];
    const handler = (e: VerifiedEvent) => {
      seen.push(e);
    };
    const now = c.clock.now();
    expect(await v.receive(sent.body, sent.headers, now, handler)).toEqual({ ok: true, outcome: "processed", eventId: "evt_1", workspaceId: "ws_a" });
    expect(await v.receive(sent.body, sent.headers, now + 1_000, handler)).toEqual({ ok: false, reason: "replayed" });
    // the red-team attack: same body, same valid signature, attacker-chosen dedupe headers
    for (const [h, val] of [["x-workflow-event-id", "evt_attacker_chosen"], ["idempotency-key", "k_attacker"], ["x-workflow-delivery-id", "dlv_x"], ["x-workflow-attempt", "7"]])
      expect(await v.receive(sent.body, { ...sent.headers, [h]: val }, now, handler), h).toEqual({ ok: false, reason: "header_mismatch" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "evt_1", workspaceId: "ws_a", type: "file.signed", idempotencyKey: scopedIdempotencyKey("ws_a", "k1"), data: { fileId: "file_1" } });
  });

  it("defence: a second legitimate delivery of the same event (a replay generation) is verified but not processed again", async () => {
    const c = make({ policy: { maxAttempts: 1 } });
    c.transport.script({ status: 500 });
    const id = c.outbox.publish(evt(), [target]).deliveries[0].id;
    await c.outbox.runDue();
    c.outbox.replay("ws_a", id, { token: "tok_avery" });
    c.clock.advance(2_000);
    await c.outbox.runDue();
    const [a, b] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    let runs = 0;
    expect(await v.receive(a.body, a.headers, c.clock.now(), () => { runs++; })).toMatchObject({ ok: true, outcome: "processed" });
    expect(await v.receive(b.body, b.headers, c.clock.now(), () => { runs++; })).toMatchObject({ ok: true, outcome: "duplicate" });
    expect(runs).toBe(1);
  });

  it("defence: a handler failure is not marked processed, so the outbox's retry runs it again", async () => {
    const c = make();
    c.transport.script({ status: 500 });
    c.outbox.publish(evt(), [target]);
    await c.outbox.runDue();
    c.clock.advance(1_000);
    await c.outbox.runDue();
    const [first, retry] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    await expect(v.receive(first.body, first.headers, c.clock.now(), () => { throw new Error("db down"); })).rejects.toThrow("db down");
    expect(v.processedSize).toBe(0);
    let runs = 0;
    expect(await v.receive(retry.body, retry.headers, c.clock.now(), () => { runs++; })).toMatchObject({ outcome: "processed" });
    expect(runs).toBe(1);
  });

  it("defence: a concurrent second delivery of an event whose handler is still running is in_progress (retry), not a duplicate", async () => {
    const c = make();
    c.outbox.publish(evt(), [target, { id: "ep_2", url: "https://b.example.test/in" }]); // two endpoints, one receiver, one secret
    await c.outbox.runDue();
    const [a, b] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    let release!: () => void;
    let runs = 0;
    const slow = v.receive(a.body, a.headers, c.clock.now(), () => { runs++; return new Promise<void>((r) => (release = r)); });
    expect(await v.receive(b.body, b.headers, c.clock.now(), () => { runs++; })).toMatchObject({ ok: true, outcome: "in_progress" });
    release();
    expect(await slow).toMatchObject({ outcome: "processed" });
    expect(runs).toBe(1);
  });

  it("review: when the running handler fails, the delivery that was told in_progress is retried and processed (nothing is lost)", async () => {
    const c = make();
    c.transport.script({ status: 500 }, { status: 503 }); // the receiver's answers: the handler failed (500), in_progress (503)
    c.outbox.publish(evt(), [target, { id: "ep_2", url: "https://b.example.test/in" }]);
    await c.outbox.runDue();
    const [a, b] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    let fail!: (e: Error) => void;
    const first = v.receive(a.body, a.headers, c.clock.now(), () => new Promise<void>((_, rej) => (fail = rej)));
    expect(await v.receive(b.body, b.headers, c.clock.now(), () => {})).toMatchObject({ outcome: "in_progress" });
    fail(new Error("db down"));
    await expect(first).rejects.toThrow("db down");
    c.clock.advance(2_000);
    await c.outbox.runDue();
    const retries = c.transport.requests.slice(2);
    expect(retries.map((q) => JSON.parse(q.body).attempt)).toEqual([2, 2]);
    expect(retries.map((q) => JSON.parse(q.body).delivery_id)).toContain(JSON.parse(b.body).delivery_id);
    let runs = 0;
    for (const q of retries) await v.receive(q.body, q.headers, c.clock.now(), () => { runs++; });
    expect(runs).toBe(1);
  });

  it("review round 2: on the durable dedupe path (processOnce, reportInProgress) a concurrent delivery is in_progress and the event is not lost", async () => {
    const c = make();
    c.transport.script({ status: 500 }, { status: 503 });
    c.outbox.publish(evt(), [target, { id: "ep_2", url: "https://b.example.test/in" }]);
    await c.outbox.runDue();
    const [a, b] = c.transport.requests;
    const rx = make(); // the receiver's own durable store
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", dedupe: (ws, id, run) => rx.outbox.processOnce(ws, id, "crm", run, { reportInProgress: true }) });
    let fail!: (e: Error) => void;
    const first = v.receive(a.body, a.headers, c.clock.now(), () => new Promise<void>((_, rej) => (fail = rej)));
    await new Promise((r) => setTimeout(r, 0));
    expect(await v.receive(b.body, b.headers, c.clock.now(), () => {})).toMatchObject({ ok: true, outcome: "in_progress" });
    fail(new Error("db down"));
    await expect(first).rejects.toThrow("db down");
    c.clock.advance(2_000);
    await c.outbox.runDue();
    let runs = 0;
    const outcomes = [];
    for (const q of c.transport.requests.slice(2)) outcomes.push((await v.receive(q.body, q.headers, c.clock.now(), () => { runs++; })) as { outcome?: string });
    expect(runs).toBe(1);
    expect(outcomes.map((o) => o.outcome)).toEqual(["processed", "duplicate"]);
  });

  it("review round 2: processOnce reports in_progress only when asked, and only while no processed mark exists", async () => {
    const c = make();
    let release!: () => void;
    const running = c.outbox.processOnce("ws_a", "e1", "crm", () => new Promise<void>((r) => (release = r)));
    expect(await c.outbox.processOnce("ws_a", "e1", "crm", () => {})).toBe("duplicate"); // default unchanged
    expect(await c.outbox.processOnce("ws_a", "e1", "crm", () => {}, { reportInProgress: true })).toBe("in_progress");
    expect(await c.outbox.processOnce("ws_b", "e1", "crm", () => {}, { reportInProgress: true })).toBe("processed"); // other workspace
    release();
    await running;
    expect(await c.outbox.processOnce("ws_a", "e1", "crm", () => {}, { reportInProgress: true })).toBe("duplicate");
  });

  it("review round 2: a full event cache under steady load frees its oldest expired entries", async () => {
    const c = make();
    for (const k of ["a", "b", "c"]) c.outbox.publish(evt({ idempotencyKey: k }), [target]);
    await c.outbox.runDue();
    const [r1, r2, r3] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", maxEvents: 2, dedupeRetentionMs: 1_000 });
    const now = c.clock.now();
    await v.receive(r1.body, r1.headers, now, () => {});
    await v.receive(r2.body, r2.headers, now + 500, () => {});
    expect(await v.receive(r3.body, r3.headers, now + 1_001, () => {})).toMatchObject({ outcome: "processed" }); // r1's id expired and was evicted
    expect(v.processedSize).toBe(2);
  });

  it("review: receive() refuses to run unbound; workspaceId and allowAnyWorkspace are exclusive and checked", async () => {
    const c = make();
    const sent = await deliveredOnce(c);
    await expect(new WebhookVerifier({ secrets: SECRET }).receive(sent.body, sent.headers, c.clock.now(), () => {})).rejects.toThrow(/bound to a workspace/);
    expect(() => new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", allowAnyWorkspace: true })).toThrow(/not both/);
    expect(() => new WebhookVerifier({ secrets: SECRET, allowAnyWorkspace: "yes" as never })).toThrow(/boolean/);
  });

  it("defence: the event-id cache is bounded and fails closed when full; expired ids are evicted", async () => {
    const c = make();
    for (const k of ["a", "b", "c"]) c.outbox.publish(evt({ idempotencyKey: k }), [target]);
    await c.outbox.runDue();
    const [r1, r2, r3] = c.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", maxEvents: 2, dedupeRetentionMs: 60_000 });
    let runs = 0;
    const h = () => { runs++; };
    const now = c.clock.now();
    expect(await v.receive(r1.body, r1.headers, now, h)).toMatchObject({ outcome: "processed" });
    expect(await v.receive(r2.body, r2.headers, now, h)).toMatchObject({ outcome: "processed" });
    expect(await v.receive(r3.body, r3.headers, now, h)).toEqual({ ok: false, reason: "dedupe_cache_full" });
    expect(runs).toBe(2);
    // a later retry of the third event after the retention period is accepted (r3 itself is stale by then)
    c.clock.advance(61_000);
    const late = await deliveredOnce(c, { idempotencyKey: "d" });
    expect(await v.receive(late.body, late.headers, c.clock.now(), h)).toMatchObject({ outcome: "processed" });
    expect(v.processedSize).toBe(1);
  });

  it("defence: a durable dedupe (Outbox.processOnce) can replace the in-memory set and is scoped by workspace", async () => {
    const c = make();
    const sent = await deliveredOnce(c);
    const store = make(); // the receiver's own store
    await store.outbox.processOnce("ws_b", "evt_1", "crm", () => {}); // same event id, other workspace: must not block ws_a
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", dedupe: (ws, id, run) => store.outbox.processOnce(ws, id, "crm", run, { reportInProgress: true }) });
    let runs = 0;
    expect(await v.receive(sent.body, sent.headers, c.clock.now(), () => { runs++; })).toMatchObject({ outcome: "processed" });
    const v2 = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", dedupe: (ws, id, run) => store.outbox.processOnce(ws, id, "crm", run, { reportInProgress: true }) }); // a restarted receiver
    expect(await v2.receive(sent.body, sent.headers, c.clock.now(), () => { runs++; })).toMatchObject({ outcome: "duplicate" });
    expect(runs).toBe(1);
    const bad = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a", dedupe: (async () => "ok") as never });
    const again = await deliveredOnce(c, { idempotencyKey: "k2" });
    await expect(bad.receive(again.body, again.headers, c.clock.now(), () => {})).rejects.toThrow(/dedupe must return/);
  });

  it("defence (cross-workspace): replay-cache and dedupe keys include the workspace, so colliding ids from two workspaces both verify and run", async () => {
    // Two outboxes with the same deterministic id generator: both first deliveries get the same event and delivery ids, attempt 1, same second.
    const a = make();
    const b = make();
    const ra = await deliveredOnce(a, { workspaceId: "ws_a" });
    const rb = await deliveredOnce(b, { workspaceId: "ws_b" });
    expect(JSON.parse(ra.body)).toMatchObject({ id: JSON.parse(rb.body).id, delivery_id: JSON.parse(rb.body).delivery_id, attempt: 1, replay: 0 });
    expect(ra.headers[SIGNATURE_HEADER].split(",")[0]).toBe(rb.headers[SIGNATURE_HEADER].split(",")[0]);
    const v = new WebhookVerifier({ secrets: SECRET });
    expect(v.verify(ra.body, ra.headers, a.clock.now()).ok).toBe(true);
    expect(v.verify(rb.body, rb.headers, b.clock.now()).ok).toBe(true);
    const r = new WebhookVerifier({ secrets: SECRET, allowAnyWorkspace: true });
    const ran: string[] = [];
    expect(await r.receive(ra.body, ra.headers, a.clock.now(), (e) => { ran.push(e.workspaceId); })).toMatchObject({ outcome: "processed" });
    expect(await r.receive(rb.body, rb.headers, b.clock.now(), (e) => { ran.push(e.workspaceId); })).toMatchObject({ outcome: "processed" });
    expect(ran).toEqual(["ws_a", "ws_b"]);
  });

  it("defence (cross-workspace): a verifier bound to one workspace refuses a validly signed request for another", async () => {
    const c = make();
    const other = await deliveredOnce(c, { workspaceId: "ws_b" });
    const v = new WebhookVerifier({ secrets: SECRET, workspaceId: "ws_a" });
    expect(v.verify(other.body, other.headers, c.clock.now())).toEqual({ ok: false, reason: "wrong_workspace" });
    let runs = 0;
    expect(await v.receive(other.body, other.headers, c.clock.now(), () => { runs++; })).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(runs).toBe(0);
    expect(v.size).toBe(0);
    const mine = await deliveredOnce(c, { workspaceId: "ws_a", idempotencyKey: "k2" });
    expect(v.verify(mine.body, mine.headers, c.clock.now()).ok).toBe(true);
    expect(() => new WebhookVerifier({ secrets: SECRET, workspaceId: "" })).toThrow(/workspaceId/);
  });

  it("a signed body whose scoped key does not match its workspace and key is refused", () => {
    const now = Date.UTC(2026, 0, 1);
    const body = JSON.stringify({ id: "e1", workspace_id: "ws_a", delivery_id: "d1", type: "t", idempotency_key: "k1", idempotency_key_scoped: scopedIdempotencyKey("ws_b", "k1"), attempt: 1, replay: 0, data: {} });
    const headers = { [SIGNATURE_HEADER]: signPayload(SECRET, body, now), "x-workflow-event-id": "e1", "x-workflow-delivery-id": "d1", "x-workflow-attempt": "1", "x-workflow-event-type": "t", "idempotency-key": scopedIdempotencyKey("ws_b", "k1") };
    expect(new WebhookVerifier({ secrets: SECRET }).verify(body, headers, now)).toEqual({ ok: false, reason: "malformed_body" });
  });
});

describe("review round 1: cross-workspace signing and option tampering", () => {
  const SECRET_B = "whsec_workspace_b_secret_0123456789";
  /** A per-workspace target registry: the secret is only found for a target the workspace owns. */
  const registry: Record<string, Record<string, string>> = { ws_a: { ep_1: SECRET }, ws_b: { ws_b_crm: SECRET_B } };
  const secretFor = (id: string, ws: string) => registry[ws]?.[id];

  it("defence (cross-workspace): secretFor gets the workspace, so ws_a cannot name ws_b's target id and get its events signed with ws_b's secret", async () => {
    const c = make({ secretFor });
    expect(() => c.outbox.publish(evt({ workspaceId: "ws_a", payload: { action: "delete_all" } }), [{ id: "ws_b_crm", url: "https://attacker.example.test/grab" }])).toThrow(/signing secret missing/);
    c.outbox.publish(evt({ workspaceId: "ws_b" }), [{ id: "ws_b_crm", url: "https://b.example.test/in" }]);
    await c.outbox.runDue();
    const v = new WebhookVerifier({ secrets: SECRET_B, workspaceId: "ws_b" });
    const req = c.transport.requests[0];
    expect(await v.receive(req.body, req.headers, c.clock.now(), () => {})).toMatchObject({ ok: true, outcome: "processed", workspaceId: "ws_b" });
    expect(c.transport.requests.map((q) => q.url)).toEqual(["https://b.example.test/in"]);
  });

  it("defence: secretFor is asked again with the workspace at send time", async () => {
    const asked: string[] = [];
    const c = make({ secretFor: (id, ws) => { asked.push(`${ws}/${id}`); return SECRET; } });
    c.outbox.publish(evt({ workspaceId: "ws_b" }), [target]);
    await c.outbox.runDue();
    expect(asked).toEqual(["ws_b/ep_1", "ws_b/ep_1"]);
  });

  it("defence: swapping the transport on the caller's options object after construction has no effect", async () => {
    const opts = { transport: new MemoryTransport() } as { transport: Transport };
    const c = make(opts as never);
    const net = scriptedNetwork();
    opts.transport = net;
    expect(() => { (c.outbox as unknown as { opts: { transport: Transport } }).opts.transport = net; }).toThrow();
    c.outbox.publish(evt(), [target]);
    await c.outbox.runDue();
    expect(net.requests).toHaveLength(0);
  });

  it("defence: sparse arrays, extra array properties and toJSON/getters that change between reads cannot slip past the payload check", () => {
    const c = make();
    expect(() => c.outbox.publish(evt({ idempotencyKey: "h", payload: { a: [1, , 3] } }), [target])).toThrow(/hole/);
    const extra = Object.assign([1, 2], { secret: "x" });
    expect(() => c.outbox.publish(evt({ idempotencyKey: "x", payload: { a: extra } }), [target])).toThrow(/extra properties/);
    let n = 0;
    const flip = { toJSON: () => (n++ === 0 ? { ok: 1 } : JSON.parse('{"__proto__":{"isAdmin":true}}')) };
    const r = c.outbox.publish(evt({ idempotencyKey: "t", payload: { flip } }), [target]);
    expect(n).toBe(1);
    expect(r.event.payload).toEqual({ flip: { ok: 1 } });
    let m = 0;
    const getter = { get a() { return m++ === 0 ? 1 : NaN; } };
    expect(c.outbox.publish(evt({ idempotencyKey: "g", payload: getter }), [target]).event.payload).toEqual({ a: 1 });
    expect(m).toBe(1);
  });

  it("defence: repeated trailing dots and empty labels in a host name are refused", () => {
    const c = make();
    for (const url of ["https://intranet../", "https://localhost../", "https://printer.local../", "https://a..example.test/"])
      expect(() => c.outbox.publish(evt({ idempotencyKey: "d" }), [{ id: "ep_d", url }]), url).toThrow(/rejected/);
    expect(c.outbox.publish(evt({ idempotencyKey: "d" }), [{ id: "ep_d", url: "https://hooks.example.test./in" }]).duplicate).toBe(false);
  });
});

describe("W5: idempotency keys", () => {
  it("defence: the idempotency-key header is scoped to the workspace, so two workspaces with the same key never collide at one receiver", async () => {
    const c = make();
    c.outbox.publish(evt({ workspaceId: "ws_a", payload: { who: "a" } }), [target]);
    c.outbox.publish(evt({ workspaceId: "ws_b", payload: { who: "b" } }), [target]);
    await c.outbox.runDue();
    const [a, b] = c.transport.requests;
    expect(a.headers["idempotency-key"]).toBe(scopedIdempotencyKey("ws_a", "k1"));
    expect(b.headers["idempotency-key"]).toBe(scopedIdempotencyKey("ws_b", "k1"));
    expect(a.headers["idempotency-key"]).not.toBe(b.headers["idempotency-key"]);
    expect(a.headers["idempotency-key"]).not.toBe("k1");
    expect(JSON.parse(a.body)).toMatchObject({ idempotency_key: "k1", idempotency_key_scoped: a.headers["idempotency-key"] });
    expect(scopedIdempotencyKey("ws_a", "k1")).toMatch(/^ik1_[0-9a-f]{64}$/);
    // unambiguous: moving characters between the workspace id and the key changes the scoped key
    expect(scopedIdempotencyKey("ws_a:", "k1")).not.toBe(scopedIdempotencyKey("ws_a", ":k1"));
  });

  it("defence: re-publishing a key with a different target list is a conflict and queues nothing for the new target", async () => {
    const c = make();
    c.outbox.publish(evt(), [target]);
    expect(() => c.outbox.publish(evt(), [{ id: "ep_new", url: "https://new.example.test/in" }])).toThrow(IdempotencyConflictError);
    expect(() => c.outbox.publish(evt(), [target, { id: "ep_new", url: "https://new.example.test/in" }])).toThrow(/target list/);
    expect(() => c.outbox.publish(evt(), [{ id: target.id, url: "https://moved.example.test/in" }])).toThrow(/target list/);
    expect(() => c.outbox.publish(evt(), [])).toThrow(/target list/);
    await c.outbox.runDue();
    expect(c.transport.requests.map((q) => q.url)).toEqual([target.url]);
  });

  it("the same key with the same targets in any order is still a duplicate", () => {
    const c = make();
    const two = [target, { id: "ep_2", url: "https://b.example.test/in" }];
    c.outbox.publish(evt(), two);
    const again = c.outbox.publish(evt(), [...two].reverse());
    expect(again.duplicate).toBe(true);
    expect(again.deliveries).toHaveLength(2);
  });

  it("defence (cross-workspace): the target-list check is per workspace; another workspace may use the same key with other targets", async () => {
    const c = make();
    c.outbox.publish(evt({ workspaceId: "ws_a" }), [target]);
    const b = c.outbox.publish(evt({ workspaceId: "ws_b" }), [{ id: "ep_b", url: "https://b.example.test/in" }]);
    expect(b.duplicate).toBe(false);
    await c.outbox.runDue();
    expect(c.transport.requests.map((q) => q.url).sort()).toEqual(["https://b.example.test/in", target.url]);
  });

  it("defence: a target listed twice in one publish is refused (the second URL used to be dropped silently)", () => {
    const c = make();
    expect(() => c.outbox.publish(evt(), [target, { id: target.id, url: "https://other.example.test/in" }])).toThrow(/listed twice/);
    expect(c.outbox.nextDueAt()).toBeNull();
  });

  it("defence: a `__proto__` key anywhere in the payload is refused at publish and nothing is queued", () => {
    const c = make();
    c.outbox.publish(evt({ payload: { a: 1 } }), [target]);
    for (const json of ['{"a":1,"__proto__":{"isAdmin":true}}', '{"a":{"b":[{"__proto__":{"x":1}}]}}']) {
      expect(() => c.outbox.publish(evt({ payload: JSON.parse(json) }), [target]), json).toThrow(/__proto__/);
      expect(() => c.outbox.publish(evt({ idempotencyKey: "k2", payload: JSON.parse(json) }), [target]), json).toThrow(/__proto__/);
    }
    expect(c.outbox.publish(evt({ payload: { a: 1 } }), [target]).duplicate).toBe(true);
    expect(c.outbox.deadLetters("ws_a")).toEqual([]);
  });

  it("defence: canonicalJson keeps an own `__proto__` key as data, so it changes the hash instead of vanishing", () => {
    const withProto = JSON.parse('{"a":1,"__proto__":{"isAdmin":true}}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"isAdmin":true},"a":1}');
    expect(payloadHash(withProto)).not.toBe(payloadHash({ a: 1 }));
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("defence: payload values JSON would drop or change (Map, Set, class instance, NaN, Infinity, function, symbol, undefined in an array) are refused", () => {
    const c = make();
    class Thing {
      x = 1;
    }
    const bad: unknown[] = [new Map([["a", 1]]), new Set([1]), new Thing(), NaN, Infinity, () => 1, Symbol("s"), [1, undefined], { [Symbol("k")]: 1 }];
    bad.forEach((v, i) => expect(() => c.outbox.publish(evt({ idempotencyKey: `b${i}`, payload: { v } }), [target]), String(i)).toThrow(/payload/));
    expect(() => c.outbox.publish(evt({ idempotencyKey: "u", payload: undefined }), [target])).toThrow(/payload/);
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { d: deep };
    expect(() => c.outbox.publish(evt({ idempotencyKey: "deep", payload: deep }), [target])).toThrow(/deeper/);
    expect(c.outbox.nextDueAt()).toBeNull();
    // Dates (toJSON), null-prototype objects and absent (undefined) object values are still fine
    const ok = c.outbox.publish(evt({ idempotencyKey: "ok", payload: { at: new Date(0), n: Object.assign(Object.create(null), { a: 1 }), gone: undefined } }), [target]);
    expect(ok.event.payload).toEqual({ at: "1970-01-01T00:00:00.000Z", n: { a: 1 } });
  });

  it("the stored, hashed and sent payload come from one serialisation (a getter cannot make them differ)", async () => {
    const c = make();
    let n = 0;
    const payload = { get v() { return ++n; } };
    const r = c.outbox.publish(evt({ payload }), [target]);
    await c.outbox.runDue();
    expect(r.event.payloadHash).toBe(payloadHash(r.event.payload));
    expect(JSON.parse(c.transport.requests[0].body).data).toEqual(r.event.payload);
  });

  it("review round 2: a payload larger than MAX_PAYLOAD_BYTES as JSON is refused and nothing is queued", () => {
    const c = make();
    expect(() => c.outbox.publish(evt({ payload: { blob: "x".repeat(MAX_PAYLOAD_BYTES) } }), [target])).toThrow(/larger than/);
    expect(() => c.outbox.publish(evt({ idempotencyKey: "u", payload: { blob: "é".repeat(MAX_PAYLOAD_BYTES / 2) } }), [target])).toThrow(/larger than/); // bytes, not characters
    expect(c.outbox.nextDueAt()).toBeNull();
    expect(c.outbox.publish(evt({ idempotencyKey: "ok", payload: { blob: "x".repeat(1000) } }), [target]).duplicate).toBe(false);
  });

  it("publish refuses a missing or unsafe workspace id", () => {
    const c = make();
    for (const ws of ["", "ws a", "ws\r\nb", "é", 5, undefined]) expect(() => c.outbox.publish(evt({ workspaceId: ws }), [target]), String(ws)).toThrow(/workspaceId/);
  });
});

describe("W1: external delivery is off by default and a future transport must meet the contract", () => {
  it("defence: a transport other than the in-memory one is refused unless externalDelivery is exactly true", () => {
    const net = scriptedNetwork();
    expect(() => make({ transport: net as unknown as MemoryTransport })).toThrow(/external delivery is disabled/);
    expect(() => make({ transport: net as unknown as MemoryTransport, externalDelivery: false })).toThrow(/external delivery is disabled/);
    expect(() => make({ transport: net as unknown as MemoryTransport, externalDelivery: "true" as never })).toThrow(/boolean/);
    expect(() => make({ transport: net as unknown as MemoryTransport, externalDelivery: true })).not.toThrow();
    expect(() => make({ externalDelivery: false })).not.toThrow(); // the in-memory transport needs no switch
  });

  it("defence: a MemoryTransport whose send is overridden (subclass or instance) counts as external", () => {
    class Leaky extends MemoryTransport {
      override async send(req: TransportRequest): Promise<TransportResponse> {
        return { status: 200, remoteAddress: req.address };
      }
    }
    const patched = new MemoryTransport();
    patched.send = async (req) => ({ status: 200, remoteAddress: req.address });
    for (const t of [new Leaky(), patched]) {
      expect(isInMemoryTransport(t)).toBe(false);
      expect(() => make({ transport: t })).toThrow(/external delivery is disabled/);
    }
    expect(isInMemoryTransport(new MemoryTransport())).toBe(true);
    expect(isInMemoryTransport({ contract: TRANSPORT_CONTRACT, send: MemoryTransport.prototype.send })).toBe(false);
  });

  it("with the switch on, a scripted network transport never receives a name that resolves to a private address", async () => {
    const net = scriptedNetwork();
    const c = make({ transport: net as unknown as MemoryTransport, externalDelivery: true });
    const hostile = ["https://127.0.0.1.nip.io/", "https://localtest.me/", "https://169.254.169.254.example.test/", "https://foo.corp/"];
    hostile.forEach((url, i) => c.outbox.publish(evt({ idempotencyKey: `h${i}` }), [{ id: `ep_${i}`, url }]));
    const r = await c.outbox.runDue(100);
    expect(r).toMatchObject({ attempted: 4, delivered: 0, deadLettered: 4 });
    expect(net.requests).toHaveLength(0);
    for (const d of c.outbox.deadLetters("ws_a")) expect(d.deadReason).toMatch(/non-public address/);
  });

  it("with the switch on, the transport gets the pinned address with the original Host/SNI and redirect: error; a redirect or another peer address is a permanent failure", async () => {
    const resolver = fakeResolver({ "hooks.example.test": [PUBLIC_IP] });
    let answer: (req: TransportRequest) => TransportResponse = (req) => ({ status: 200, remoteAddress: req.address });
    const net = scriptedNetwork((req) => answer(req));
    const c = make({ transport: net as unknown as MemoryTransport, externalDelivery: true, resolver });
    await deliveredOnce(c);
    expect(net.requests[0]).toMatchObject({ url: target.url, address: PUBLIC_IP, port: 443, hostHeader: "hooks.example.test", servername: "hooks.example.test", redirect: "error" });
    answer = (req) => (req.url.includes("o.example") ? { status: 200, remoteAddress: "10.0.0.5" } : { status: 307, remoteAddress: PUBLIC_IP });
    const red = c.outbox.publish(evt({ idempotencyKey: "r" }), [target]).deliveries[0].id;
    const other = c.outbox.publish(evt({ idempotencyKey: "o" }), [{ id: "ep_o", url: "https://o.example.test/" }]).deliveries[0].id;
    await c.outbox.runDue();
    expect(c.outbox.getDelivery("ws_a", red)!.deadReason).toMatch(/redirects are not followed/);
    expect(c.outbox.getDelivery("ws_a", other)!.deadReason).toMatch(/contract violation/);
  });

  it("defence: single-label host names are refused at publish (resolver search domains can make them internal)", () => {
    const c = make();
    for (const url of ["https://intranet/", "https://intranet./x", "https://printer:443/"]) expect(() => c.outbox.publish(evt({ idempotencyKey: "s" }), [{ id: "ep_s", url }]), url).toThrow(/single-label/);
    expect(c.outbox.publish(evt({ idempotencyKey: "s" }), [{ id: "ep_s", url: "https://[2606:4700::1111]/" }]).duplicate).toBe(false);
  });
});
