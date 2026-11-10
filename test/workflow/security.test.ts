// Fixes for the S11 red-team findings W1-W4 on the workflow outbox. Fake resolver and in-memory transport only:
// nothing here performs a DNS lookup or a network request.
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MIN_SECRET_LENGTH,
  MemoryTransport,
  ReplayDeniedError,
  SIGNATURE_HEADER,
  TRANSPORT_CONTRACT,
  TargetRefusedError,
  WebhookVerifier,
  isPublicAddress,
  resolveAndPin,
  signPayload,
  verifySignature,
  type Transport,
  type TransportRequest,
} from "../../lib/workflow";
import { OPERATOR, PUBLIC_IP, SECRET, evt, fakeResolver, setup, target } from "./helpers";

let ctx: ReturnType<typeof setup>;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined as never; // tests that never call setup() must not close the previous test's outbox twice
});

const PRIVATE_DNS = {
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "localtest.me": ["127.0.0.1", "::1"],
  "169.254.169.254.example.test": ["169.254.169.254"],
  "foo.corp": ["10.0.0.5"],
  "mixed.example.test": [PUBLIC_IP, "192.168.1.10"],
  "mapped.example.test": ["::ffff:127.0.0.1"],
  "nat64.example.test": ["64:ff9b::a9fe:a9fe"],
  "sixtofour.example.test": ["2002:7f00:1::1"],
};

describe("W1: address policy", () => {
  it("refuses every non-public address form", () => {
    for (const a of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.5", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
      "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "::127.0.0.1", "::a9fe:a9fe",
      "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b::8.8.8.8", "64:ff9b:1::1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:808:808::1",
      "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:2::1", "2001:10::1", "2001:db8::1", "3fff::1",
      "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff05::1:3",
      "fe80::1%eth0", "1.2.3", "01.2.3.4", "1.2.3.256", "1.2.3.4.5", "", "example.test", "::ffff:999.0.0.1", "1:2:3:4:5:6:7:8:9", "1::2::3",
    ])
      expect(isPublicAddress(a), a).toBe(false);
  });
  it("accepts public unicast addresses", () => {
    for (const a of ["8.8.8.8", PUBLIC_IP, "100.63.255.255", "100.128.0.1", "172.32.0.1", "192.1.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "2001:4860::8888"])
      expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("W1: resolveAndPin", () => {
  it("refuses a public-looking name when ANY answer is non-public (nip.io, localtest.me, mixed, mapped, NAT64, 6to4)", async () => {
    const resolver = fakeResolver(PRIVATE_DNS);
    for (const host of Object.keys(PRIVATE_DNS)) {
      const err = await resolveAndPin(`https://${host}/hook`, resolver).catch((e) => e);
      expect(err, host).toBeInstanceOf(TargetRefusedError);
      expect(err.kind, host).toBe("policy");
    }
  });
  it("pins the first answer in canonical form and keeps the original host for Host and SNI", async () => {
    const resolver = fakeResolver({ "hooks.example.test": ["2606:4700:0:0:0:0:0:1111", "8.8.8.8"] });
    const p = await resolveAndPin("https://Hooks.Example.Test./in?x=1", resolver);
    expect(p).toMatchObject({ hostname: "hooks.example.test", port: 443, address: "2606:4700::1111", family: 6, servername: "hooks.example.test" });
    expect(p.hostHeader).toBe("hooks.example.test");
    expect(resolver.lookups).toEqual(["hooks.example.test"]);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("does not look up an IP literal, and sends no SNI for it", async () => {
    const resolver = fakeResolver();
    expect(await resolveAndPin("https://[2606:4700::1111]/in", resolver)).toMatchObject({ address: "2606:4700::1111", family: 6, servername: null, hostHeader: "[2606:4700::1111]" });
    expect(await resolveAndPin("https://93.184.215.14/in", resolver)).toMatchObject({ address: "93.184.215.14", family: 4, servername: null });
    expect(resolver.lookups).toEqual([]);
  });
  it("refuses URLs the publish policy refuses, without a lookup", async () => {
    const resolver = fakeResolver();
    for (const u of ["http://hooks.example.test/", "https://127.0.0.1/", "https://localhost/", "https://u:p@hooks.example.test/", "https://hooks.example.test:8443/"])
      await expect(resolveAndPin(u, resolver), u).rejects.toMatchObject({ kind: "policy" });
    expect(resolver.lookups).toEqual([]);
  });
  it("lookup failures are resolution errors; junk answers are policy errors", async () => {
    const throwing = async () => { throw new Error("ENOTFOUND"); };
    await expect(resolveAndPin("https://a.example.test/", throwing)).rejects.toMatchObject({ kind: "resolution" });
    await expect(resolveAndPin("https://a.example.test/", async () => [])).rejects.toMatchObject({ kind: "resolution" });
    await expect(resolveAndPin("https://a.example.test/", async () => "8.8.8.8" as never)).rejects.toMatchObject({ kind: "resolution" });
    for (const bad of [["not-an-ip"], [8 as never], ["8.8.8.8", ""], Array(33).fill("8.8.8.8")])
      await expect(resolveAndPin("https://a.example.test/", async () => bad), JSON.stringify(bad).slice(0, 40)).rejects.toMatchObject({ kind: "policy" });
  });
});

describe("W1: the outbox resolves, pins and re-checks before every send", () => {
  it("adapted FINDING: names that resolve to private addresses are never sent; the delivery is dead-lettered", async () => {
    ctx = setup({ resolver: fakeResolver(PRIVATE_DNS) });
    const hosts = Object.keys(PRIVATE_DNS);
    hosts.forEach((h, i) => ctx.outbox.publish(evt({ idempotencyKey: `d${i}` }), [{ id: `ep_${i}`, url: `https://${h}/` }])); // publish accepts the names
    const r = await ctx.outbox.runDue(100);
    expect(r).toMatchObject({ attempted: hosts.length, delivered: 0, deadLettered: hosts.length });
    expect(ctx.transport.requests).toHaveLength(0);
    for (const d of ctx.outbox.deadLetters("ws_a")) expect(d.deadReason).toMatch(/permanent failure: target refused: host resolves to a non-public address/);
  });
  it("the transport gets the pinned address, original Host/SNI and redirect: error; one lookup per attempt", async () => {
    const resolver = fakeResolver();
    ctx = setup({ resolver });
    ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    const req = ctx.transport.requests[0];
    expect(req).toMatchObject({ url: target.url, address: PUBLIC_IP, family: 4, port: 443, hostHeader: "hooks.example.test", servername: "hooks.example.test", redirect: "error" });
    expect(resolver.lookups).toEqual(["hooks.example.test"]);
  });
  it("DNS rebinding: a public first answer is pinned for that attempt, and a private second answer stops the retry", async () => {
    const answers = [[PUBLIC_IP], ["127.0.0.1"]];
    const resolver = fakeResolver({ "rebind.example.test": () => answers.shift() ?? ["127.0.0.1"] });
    ctx = setup({ resolver });
    ctx.transport.script({ status: 503 });
    const id = ctx.outbox.publish(evt(), [{ id: "ep_r", url: "https://rebind.example.test/in" }]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.transport.requests.map((q) => q.address)).toEqual([PUBLIC_IP]);
    expect(resolver.lookups).toHaveLength(1); // no second lookup inside the attempt
    ctx.clock.advance(60_000);
    await ctx.outbox.runDue();
    expect(resolver.lookups).toHaveLength(2);
    expect(ctx.transport.requests).toHaveLength(1); // the rebound answer is never connected to
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "dead" });
    expect(ctx.outbox.audit("ws_a", id).map((a) => a.outcome)).toEqual(["retry_scheduled", "dead_lettered"]);
  });
  it("a failed lookup is retried, a hung lookup is cut off by the attempt deadline", async () => {
    let calls = 0;
    ctx = setup({ resolver: async () => { calls++; throw new Error("SERVFAIL"); } });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "pending", lastError: "target refused: dns lookup failed" });
    expect(calls).toBe(1);
    ctx.cleanup();
    ctx = setup({ resolver: () => new Promise(() => {}), timeoutMs: 20, leaseMs: 1000 });
    const id2 = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    expect((await ctx.outbox.runDue()).retryScheduled).toBe(1);
    expect(ctx.outbox.getDelivery("ws_a", id2)).toMatchObject({ lastError: "timeout" });
    expect(ctx.transport.requests).toHaveLength(0);
  });
  it("a response from an address other than the pinned one is a permanent contract violation", async () => {
    ctx = setup();
    ctx.transport.script({ status: 200, remoteAddress: "10.0.0.1" });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "dead", lastError: "transport contract violation: connected to an address other than the pinned one" });
  });
  it("accepts the pinned address reported in IPv4-mapped form, refuses a missing or invalid one", async () => {
    ctx = setup();
    ctx.transport.script({ status: 200, remoteAddress: `::ffff:${PUBLIC_IP}` });
    const a = ctx.outbox.publish(evt({ idempotencyKey: "a" }), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", a)!.status).toBe("delivered");
    ctx.transport.send = async (req: TransportRequest) => { ctx.transport.requests.push(req); return { status: 200 } as never; };
    const b = ctx.outbox.publish(evt({ idempotencyKey: "b" }), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    expect(ctx.outbox.getDelivery("ws_a", b)!.lastError).toMatch(/contract violation/);
  });
  it("a redirect status is a permanent failure and is not followed", async () => {
    ctx = setup();
    for (const status of [301, 302, 307, 308]) ctx.transport.script({ status });
    const ids = [0, 1, 2, 3].map((i) => ctx.outbox.publish(evt({ idempotencyKey: `r${i}` }), [target]).deliveries[0].id);
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(4);
    for (const id of ids) expect(ctx.outbox.getDelivery("ws_a", id)!.deadReason).toMatch(/redirects are not followed/);
  });
  it("the outbox refuses a transport that does not declare the contract, and requires a resolver", () => {
    const bare = { send: async () => ({ status: 200, remoteAddress: PUBLIC_IP }) } as unknown as Transport;
    const following = { contract: { ...TRANSPORT_CONTRACT, redirects: "follow" }, send: bare.send } as unknown as Transport;
    const lookingUp = { contract: { ...TRANSPORT_CONTRACT, connect: "resolve" }, send: bare.send } as unknown as Transport;
    for (const transport of [bare, following, lookingUp, null as unknown as Transport])
      expect(() => setup({ transport: transport as MemoryTransport })).toThrow(/transport contract/);
    expect(() => setup({ resolver: undefined })).toThrow(/resolver/);
    expect(new MemoryTransport().contract).toEqual({ version: 1, redirects: "never", connect: "pinned_address_only" });
  });
});

describe("W2: header-bound values", () => {
  it("adapted FINDING: an event type with CR/LF (or any non-token character) is refused at publish and nothing is queued", () => {
    ctx = setup();
    for (const type of ["file.signed\r\nX-Injected: 1", "file.signed\n", "a\rb", "a b", "a:b", "", ".lead", "é", "a\u0000b", "a b", "x".repeat(101), 42 as never])
      expect(() => ctx.outbox.publish(evt({ type, idempotencyKey: "t" }), [target]), JSON.stringify(type)).toThrow(/type must be/);
    expect(ctx.outbox.nextDueAt()).toBeNull();
    expect(ctx.outbox.publish(evt({ type: "intake.review_task.created" }), [target]).duplicate).toBe(false);
    expect(() => ctx.outbox.publish(evt({ type: "x".repeat(100), idempotencyKey: "k100" }), [target])).not.toThrow();
  });
  it("a stored row with an unsafe header value is never sent", async () => {
    ctx = setup();
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    const db = new DatabaseSync(path.join(ctx.dir, "wf.db"));
    db.prepare("UPDATE wf_events SET type = ?").run("file.signed\r\nX-Injected: 1"); // e.g. written by an older version
    db.close();
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(0);
    expect(ctx.outbox.getDelivery("ws_a", id)).toMatchObject({ status: "dead", lastError: "unsafe x-workflow-event-type header value" });
  });
  it("every header the outbox sends is printable ASCII", async () => {
    ctx = setup();
    ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    for (const v of Object.values(ctx.transport.requests[0].headers)) expect(v).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("W3: replay authorization", () => {
  async function dead(over: Parameters<typeof setup>[0] = {}) {
    ctx = setup({ policy: { maxAttempts: 1 }, ...over });
    ctx.transport.setFallback({ status: 500 });
    const { deliveries } = ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    return deliveries[0].id;
  }
  const denials = () => ctx.outbox.audit("ws_a").filter((r) => r.outcome === "replay_denied");

  it("adapted FINDING: a caller-supplied operator name is not a credential; the denial is audited and the letter stays dead", async () => {
    const id = await dead();
    expect(() => ctx.outbox.replay("ws_a", id, "ops-alice")).toThrow(ReplayDeniedError);
    expect(() => ctx.outbox.replay("ws_a", id, { token: "forged" })).toThrow(/unauthenticated/);
    expect(ctx.outbox.getDelivery("ws_a", id)!.status).toBe("dead");
    expect(denials()).toHaveLength(2);
    expect(denials().every((r) => r.actor === null && r.error === "unauthenticated")).toBe(true);
    expect(ctx.outbox.audit("ws_a").some((r) => r.actor === "ops-alice")).toBe(false);
  });
  it("without an authoriser every replay is denied", async () => {
    const id = await dead({ replayAuthorizer: undefined });
    expect(() => ctx.outbox.replay("ws_a", id, OPERATOR)).toThrow(/no replay authoriser configured/);
    expect(ctx.outbox.getDelivery("ws_a", id)!.status).toBe("dead");
    expect(denials()).toHaveLength(1);
  });
  it("needs the operator role for that workspace", async () => {
    const id = await dead();
    expect(() => ctx.outbox.replay("ws_a", id, { token: "tok_reader" })).toThrow(/missing workflow_operator role/);
    expect(ctx.outbox.getDelivery("ws_a", id)!.status).toBe("dead");
  });
  it("a throwing authoriser, a missing decision or an unsafe operator id is a denial", async () => {
    for (const authorizeReplay of [
      () => { throw new Error("db down"); },
      () => undefined as never,
      () => ({ allowed: true, operatorId: "op\r\nx" }) as const,
      () => ({ allowed: true, operatorId: "" }) as const,
      () => ({ allowed: "yes", operatorId: "op" }) as never,
    ]) {
      const id = await dead({ replayAuthorizer: { authorizeReplay } });
      expect(() => ctx.outbox.replay("ws_a", id, OPERATOR)).toThrow(ReplayDeniedError);
      expect(ctx.outbox.getDelivery("ws_a", id)!.status).toBe("dead");
      ctx.cleanup();
    }
    ctx = setup();
  });
  it("an authorised replay audits the operator id the authoriser verified", async () => {
    const id = await dead();
    ctx.outbox.replay("ws_a", id, OPERATOR);
    expect(ctx.outbox.audit("ws_a", id).at(-1)).toMatchObject({ outcome: "replayed", actor: "op_avery" });
  });
  it("adapted FINDING: replays per delivery are capped, so a permanently failing delivery cannot be replayed without limit", async () => {
    const id = await dead({ maxReplays: 2 });
    for (let i = 0; i < 2; i++) {
      ctx.outbox.replay("ws_a", id, OPERATOR);
      await ctx.outbox.runDue();
    }
    expect(() => ctx.outbox.replay("ws_a", id, OPERATOR)).toThrow(/replay limit \(2\) reached/);
    expect(ctx.transport.requests).toHaveLength(3);
    expect(ctx.outbox.getDelivery("ws_a", id)!.status).toBe("dead");
    expect(denials().at(-1)).toMatchObject({ actor: "op_avery", error: "replay limit (2) reached" });
    expect(() => setup({ maxReplays: -1 })).toThrow(/maxReplays/);
  });
  it("another workspace's denied replay leaves no audit row in either workspace", async () => {
    const id = await dead();
    expect(() => ctx.outbox.replay("ws_b", id, { token: "nobody" })).toThrow(ReplayDeniedError);
    expect(ctx.outbox.audit("ws_b")).toEqual([]);
    expect(denials()).toEqual([]);
  });
});

describe("W4: receiver-side replay cache (WebhookVerifier)", () => {
  async function sent(n = 1) {
    ctx = setup();
    for (let i = 0; i < n; i++) ctx.outbox.publish(evt({ idempotencyKey: `k${i}` }), [target]);
    await ctx.outbox.runDue(100);
    return ctx.transport.requests;
  }

  it("adapted FINDING: the same signed request verifies once; a re-send inside the window is refused as replayed", async () => {
    const [req] = await sent();
    const v = new WebhookVerifier({ secrets: SECRET });
    expect(v.verify(req.body, req.headers, ctx.clock.now() + 1_000)).toEqual({ ok: true, eventId: "evt_1", deliveryId: req.headers["x-workflow-delivery-id"], attempt: 1 });
    for (const dt of [1_000, 60_000, 299_000]) expect(v.verify(req.body, req.headers, ctx.clock.now() + dt)).toEqual({ ok: false, reason: "replayed" });
    expect(v.verify(req.body, req.headers, ctx.clock.now() + 301_000)).toEqual({ ok: false, reason: "stale" });
  });
  it("adapted FINDING: the id headers are bound to the signed body, so a forged or missing event-id header is refused", async () => {
    const [req] = await sent();
    const v = new WebhookVerifier({ secrets: SECRET });
    const now = ctx.clock.now();
    for (const [h, val] of [["x-workflow-event-id", "evt_attacker_chosen"], ["x-workflow-delivery-id", "dlv_other"], ["x-workflow-attempt", "9"]])
      expect(v.verify(req.body, { ...req.headers, [h]: val }, now), h).toEqual({ ok: false, reason: "header_mismatch" });
    const { ["x-workflow-event-id"]: _dropped, ...rest } = req.headers;
    void _dropped;
    expect(v.verify(req.body, rest, now)).toEqual({ ok: false, reason: "header_mismatch" });
    expect(v.verify(req.body, { ...req.headers, "X-Workflow-Event-Id": "evt_1" }, now)).toEqual({ ok: false, reason: "malformed" }); // same header twice
    expect(v.size).toBe(0); // refused requests are not cached
    expect(v.verify(req.body, req.headers, now).ok).toBe(true);
  });
  it("a retry of the same delivery (a new attempt with a new signature) is accepted", async () => {
    ctx = setup();
    ctx.transport.script({ status: 500 });
    ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    ctx.clock.advance(800);
    await ctx.outbox.runDue();
    const [first, second] = ctx.transport.requests;
    const v = new WebhookVerifier({ secrets: SECRET });
    expect(v.verify(first.body, first.headers, ctx.clock.now()).ok).toBe(true);
    expect(v.verify(second.body, second.headers, ctx.clock.now())).toMatchObject({ ok: true, attempt: 2 });
  });
  it("is bounded: when full of live entries it fails closed, and expired entries are evicted", async () => {
    const reqs = await sent(3);
    const v = new WebhookVerifier({ secrets: SECRET, maxEntries: 2 });
    const now = ctx.clock.now();
    expect(v.verify(reqs[0].body, reqs[0].headers, now).ok).toBe(true);
    expect(v.verify(reqs[1].body, reqs[1].headers, now).ok).toBe(true);
    expect(v.verify(reqs[2].body, reqs[2].headers, now)).toEqual({ ok: false, reason: "replay_cache_full" });
    expect(v.size).toBe(2);
    // after the window, old entries go and a fresh request is accepted
    ctx.clock.advance(301_000);
    ctx.outbox.publish(evt({ idempotencyKey: "late" }), [target]);
    await ctx.outbox.runDue();
    const late = ctx.transport.requests.at(-1)!;
    expect(v.verify(late.body, late.headers, ctx.clock.now()).ok).toBe(true);
    expect(v.size).toBe(1);
  });
  it("refuses unsigned, tampered, non-JSON and wrong-shape bodies", async () => {
    const [req] = await sent();
    const v = new WebhookVerifier({ secrets: SECRET });
    const now = ctx.clock.now();
    expect(v.verify(req.body + " ", req.headers, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(v.verify(req.body, { ...req.headers, [SIGNATURE_HEADER]: undefined }, now)).toEqual({ ok: false, reason: "malformed" });
    for (const body of ["not json", "[]", JSON.stringify({ id: "e" }), JSON.stringify({ id: "e", delivery_id: "d", attempt: 0 })])
      expect(v.verify(body, { ...req.headers, [SIGNATURE_HEADER]: signPayload(SECRET, body, now) }, now), body).toEqual({ ok: false, reason: "malformed_body" });
  });
  it("accepts either secret during rotation", async () => {
    const [req] = await sent();
    const v = new WebhookVerifier({ secrets: ["n".repeat(MIN_SECRET_LENGTH), SECRET] });
    expect(v.verify(req.body, req.headers, ctx.clock.now()).ok).toBe(true);
  });
});

describe("W4: empty and short signing secrets", () => {
  const body = JSON.stringify({ id: "evt_1" });
  const now = Date.UTC(2026, 0, 1, 12);
  const short = "x".repeat(MIN_SECRET_LENGTH - 1);
  it("adapted FINDING: an empty or short secret never verifies (not even a forgery made with the same empty secret)", () => {
    const forged = signPayload(SECRET, body, now).replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`);
    for (const secrets of ["", [""], [], short, [SECRET, ""], [SECRET, short], [undefined as never]])
      expect(verifySignature(secrets, body, forged, now), JSON.stringify(secrets)).toEqual({ ok: false, reason: "invalid_secret" });
    expect(verifySignature(SECRET, body, signPayload(SECRET, body, now), now)).toEqual({ ok: true });
  });
  it("the signer refuses an empty or short secret", () => {
    for (const s of ["", short, " ".repeat(40), undefined as never]) expect(() => signPayload(s, body, now)).toThrow(/at least 32/);
  });
  it("the verifier refuses an empty or short secret when it is configured", () => {
    for (const secrets of ["", [""], [], short, [SECRET, short]]) expect(() => new WebhookVerifier({ secrets }), JSON.stringify(secrets)).toThrow();
    expect(() => new WebhookVerifier({ secrets: SECRET, toleranceSeconds: 0 })).toThrow(/toleranceSeconds/);
    expect(() => new WebhookVerifier({ secrets: SECRET, maxEntries: 0 })).toThrow(/maxEntries/);
  });
  it("the outbox refuses a target with a missing, short or blank secret at publish", () => {
    for (const s of [undefined, "", short, " ".repeat(64)]) {
      ctx = setup({ secretFor: () => s });
      expect(() => ctx.outbox.publish(evt(), [target]), JSON.stringify(s)).toThrow(/signing secret missing or shorter than 32/);
      expect(ctx.outbox.nextDueAt()).toBeNull();
      ctx.cleanup();
    }
    ctx = undefined as never;
  });
  it("the outbox does not send when the secret has become short by send time", async () => {
    let secret = SECRET;
    ctx = setup({ secretFor: () => secret });
    ctx.outbox.publish(evt(), [target]);
    secret = short;
    await ctx.outbox.runDue();
    expect(ctx.transport.requests).toHaveLength(0);
    expect(ctx.outbox.audit("ws_a")[0]).toMatchObject({ outcome: "retry_scheduled", error: "signing secret too short" });
  });
});


describe("W1: the default test resolver models the red-team names", () => {
  it("adapted FINDING (default setup): 127.0.0.1.nip.io, localtest.me, 169.254.169.254.example.test and foo.corp are never sent", async () => {
    ctx = setup();
    const dns = ["https://127.0.0.1.nip.io/", "https://localtest.me/", "https://169.254.169.254.example.test/", "https://foo.corp/"];
    dns.forEach((url, i) => ctx.outbox.publish(evt({ idempotencyKey: `d${i}` }), [{ id: `ep_${i}`, url }]));
    const r = await ctx.outbox.runDue(100);
    expect(r).toMatchObject({ delivered: 0, deadLettered: dns.length });
    expect(ctx.transport.requests).toEqual([]);
  });
});

describe("review follow-ups", () => {
  it("a target URL with CR/LF, tab, space or backslash is refused, and the transport gets the normalised URL", async () => {
    ctx = setup();
    for (const url of ["https://exa\r\nmple.test/in", "https://hooks.example.test/pa\r\nth", "https://example.test\t.evil.test/x", "https://hooks.example.test/a b", "https://hooks.example.test\\@evil.test/", " https://hooks.example.test/", "https://hooks.example.test/\u0000"])
      expect(() => ctx.outbox.publish(evt({ idempotencyKey: "u" }), [{ id: "ep_u", url }]), JSON.stringify(url)).toThrow(/rejected/);
    await expect(resolveAndPin("https://hooks.example.test/pa\r\nth", fakeResolver())).rejects.toMatchObject({ kind: "policy" });
    const p = await resolveAndPin("https://HOOKS.example.test/a/../in?q=1", fakeResolver());
    expect(p.url).toBe("https://hooks.example.test/in?q=1");
  });
  it("the transport gets the time left after the lookup and a signal that aborts at the deadline", async () => {
    ctx = setup({ timeoutMs: 200, leaseMs: 1000, resolver: async () => { await new Promise((r) => setTimeout(r, 40)); return [PUBLIC_IP]; } });
    let seen: TransportRequest | undefined;
    ctx.transport.send = (req) => { seen = req; return new Promise(() => {}); };
    ctx.outbox.publish(evt(), [target]);
    expect((await ctx.outbox.runDue()).retryScheduled).toBe(1);
    expect(seen!.timeoutMs).toBeGreaterThan(0);
    expect(seen!.timeoutMs).toBeLessThanOrEqual(170);
    expect(seen!.signal.aborted).toBe(true);
  });
  it("the verifier binds the event-type and idempotency-key headers to the signed body", async () => {
    ctx = setup();
    ctx.outbox.publish(evt(), [target]);
    await ctx.outbox.runDue();
    const req = ctx.transport.requests[0];
    const v = new WebhookVerifier({ secrets: SECRET });
    for (const [h, val] of [["x-workflow-event-type", "file.voided"], ["idempotency-key", "other"]])
      expect(v.verify(req.body, { ...req.headers, [h]: val }, ctx.clock.now()), h).toEqual({ ok: false, reason: "header_mismatch" });
    expect(JSON.parse(req.body)).toMatchObject({ type: "file.signed", idempotency_key: "k1", attempt: 1, replay: 0 });
  });
  it("a replayed delivery re-sent in the same second as its last attempt is not mistaken for a captured replay", async () => {
    ctx = setup({ policy: { maxAttempts: 1 } });
    ctx.transport.setFallback({ status: 500 });
    const id = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
    await ctx.outbox.runDue();
    ctx.outbox.replay("ws_a", id, OPERATOR);
    await ctx.outbox.runDue(); // same fake-clock second, attempt 1 again
    const [a, b] = ctx.transport.requests;
    expect(a.headers[SIGNATURE_HEADER].split(",")[0]).toBe(b.headers[SIGNATURE_HEADER].split(",")[0]);
    const v = new WebhookVerifier({ secrets: SECRET });
    expect(v.verify(a.body, a.headers, ctx.clock.now()).ok).toBe(true);
    expect(v.verify(b.body, b.headers, ctx.clock.now()).ok).toBe(true);
    expect(JSON.parse(b.body).replay).toBe(1);
  });
  it("an async authoriser is denied, and dns.lookup-style answers are accepted", async () => {
    const id = await (async () => {
      ctx = setup({ policy: { maxAttempts: 1 }, replayAuthorizer: { authorizeReplay: (async () => ({ allowed: true, operatorId: "op" })) as never } });
      ctx.transport.setFallback({ status: 500 });
      const d = ctx.outbox.publish(evt(), [target]).deliveries[0].id;
      await ctx.outbox.runDue();
      return d;
    })();
    expect(() => ctx.outbox.replay("ws_a", id, OPERATOR)).toThrow(/authoriser must be synchronous/);
    expect(await resolveAndPin("https://a.example.test/", async () => [{ address: "8.8.8.8" }])).toMatchObject({ address: "8.8.8.8" });
    await expect(resolveAndPin("https://a.example.test/", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }])).rejects.toMatchObject({ kind: "policy" });
  });
});
