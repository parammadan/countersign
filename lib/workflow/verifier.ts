// Receiver-side webhook verification with a bounded replay cache and event-id dedupe. Pure: time is passed in,
// nothing is stored on disk.
//
// Receiver contract (what a consumer of the outbox's webhooks must do):
//  1. Verify with WebhookVerifier, never with verifySignature alone: that primitive is stateless and covers the
//     body only, not the headers.
//  2. Dedupe processing on the SIGNED event id (`id` in the body, scoped by the signed `workspace_id`), never on
//     a header. `receive()` does this. `verify()` is the older, lower-level call: its result carries no workspace,
//     so use it only on a verifier bound to one workspace (`workspaceId`), and dedupe on (that workspace, eventId).
//  3. Use the `idempotency-key` header (or `idempotency_key_scoped` in the body) as the downstream idempotency key:
//     it is the tenant key scoped to the workspace, so two workspaces never collide at one receiver.
//  4. Bind the verifier to the workspace that owns the secret (`workspaceId`), so a request for any other workspace
//     is refused; `receive()` refuses to run unbound unless `allowAnyWorkspace` is set explicitly. On the sending
//     side, `secretFor(targetId, workspaceId)` must only return a secret for a target that workspace owns.
//  5. Reply 2xx to "processed", "duplicate" and "replayed"; reply 503 to "in_progress" and to any failure that may
//     pass later (cache full), so the outbox retries; a handler error should also be a 5xx.
import { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER, assertSigningSecret, checkSignature, scopedIdempotencyKey, type VerifyFailure } from "./signing";

export interface WebhookVerifierOptions {
  /** Current secret, or several during rotation. Each must be at least MIN_SECRET_LENGTH characters. */
  secrets: string | readonly string[];
  toleranceSeconds?: number;
  /** Most (delivery, replay, attempt, timestamp) entries kept. When full of unexpired entries, new requests are refused. */
  maxEntries?: number;
  /** Only events of this workspace verify; any other is refused as "wrong_workspace". Required by receive(). */
  workspaceId?: string;
  /**
   * receive() without `workspaceId`: accept events of every workspace (one shared secret for several workspaces).
   * The caches are then shared, so one workspace can fill them for the others; prefer one verifier per workspace.
   */
  allowAnyWorkspace?: boolean;
  /** receive(): how long a processed event id is remembered in memory (default 7 days). */
  dedupeRetentionMs?: number;
  /** receive(): most event ids remembered in memory (default 100,000). When full of unexpired ids, new events are refused. */
  maxEvents?: number;
  /**
   * receive(): durable dedupe instead of the in-memory set, e.g.
   * `(ws, id, run) => outbox.processOnce(ws, id, "crm", run, { reportInProgress: true })`. It must run `run` at most
   * once per (workspace, event id), only mark the event done after `run` succeeds, and report "in_progress" (not
   * "duplicate") while another run of the same event holds the claim.
   */
  dedupe?: (workspaceId: string, eventId: string, run: () => Promise<void>) => Promise<"processed" | "duplicate" | "in_progress">;
}

export type WebhookVerifyFailure = VerifyFailure | "malformed_body" | "header_mismatch" | "wrong_workspace" | "replayed" | "replay_cache_full" | "dedupe_cache_full";
export type WebhookVerifyResult =
  | { ok: true; eventId: string; deliveryId: string; attempt: number }
  | { ok: false; reason: WebhookVerifyFailure };

/** The signed values a handler may act on. Taken from the signed body, never from a header. */
export interface VerifiedEvent {
  id: string;
  workspaceId: string;
  type: string;
  /** The tenant key scoped to the workspace (the `idempotency-key` header value). */
  idempotencyKey: string;
  createdAt: unknown;
  data: unknown;
}

export type ReceiveResult =
  /** in_progress: another delivery of this event is being handled right now; reply 503 so the outbox retries. */
  | { ok: true; outcome: "processed" | "duplicate" | "in_progress"; eventId: string; workspaceId: string }
  | { ok: false; reason: WebhookVerifyFailure };

type Headers = Record<string, string | readonly string[] | undefined>;
type Body = Record<string, unknown> & { id: string; workspace_id: string; delivery_id: string; type: string; idempotency_key: string; idempotency_key_scoped: string; attempt: number; replay: number };

/** The headers the outbox sends that a receiver may act on; each must match the signed body. */
const BOUND_HEADERS = [
  ["x-workflow-event-id", "id"],
  ["x-workflow-delivery-id", "delivery_id"],
  ["x-workflow-attempt", "attempt"],
  ["x-workflow-event-type", "type"],
  ["idempotency-key", "idempotency_key_scoped"],
] as const;

/**
 * Verifies the signature, requires the unsigned id headers to be present and equal to the signed body, and accepts each
 * (workspace, event, delivery id, replay generation, attempt, signed timestamp) once while it is inside the tolerance window.
 * Every legitimate send is a new attempt with a fresh signature, so only a re-sent captured request is refused as
 * "replayed". Treat "replayed" as already received (reply 2xx, do not process again). Use `receive()` to also dedupe
 * processing on the signed event id; with `verify()` alone the caller must dedupe on the returned eventId.
 * The caches are per process: run one verifier per receiver, or pass a durable `dedupe`.
 */
export class WebhookVerifier {
  private readonly secrets: readonly string[];
  private readonly tolerance: number;
  private readonly maxEntries: number;
  private readonly workspaceId: string | undefined;
  private readonly retentionMs: number;
  private readonly maxEvents: number;
  private readonly dedupe: WebhookVerifierOptions["dedupe"];
  /** key -> epoch ms after which the timestamp is stale anyway and the entry can go. */
  private readonly seen = new Map<string, number>();
  /** (workspace, event id) -> epoch ms until which it counts as processed. */
  private readonly processed = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly allowAny: boolean;
  /** Earliest expiry in each cache, so a full cache is only scanned when something can actually be evicted. */
  private seenMinExpiry = Infinity;
  private processedMinExpiry = Infinity;

  constructor(opts: WebhookVerifierOptions) {
    const list = Array.isArray(opts.secrets) ? [...opts.secrets] : [opts.secrets];
    if (list.length === 0) throw new Error("at least one signing secret is required");
    for (const s of list) assertSigningSecret(s);
    this.secrets = Object.freeze(list as string[]);
    this.tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.retentionMs = opts.dedupeRetentionMs ?? 7 * 24 * 3600_000;
    this.maxEvents = opts.maxEvents ?? 100_000;
    if (!Number.isInteger(this.tolerance) || this.tolerance <= 0 || this.tolerance > 3600) throw new Error("toleranceSeconds must be an integer in 1..3600");
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) throw new Error("maxEntries must be a positive integer");
    if (!Number.isInteger(this.retentionMs) || this.retentionMs <= 0) throw new Error("dedupeRetentionMs must be a positive integer");
    if (!Number.isInteger(this.maxEvents) || this.maxEvents <= 0) throw new Error("maxEvents must be a positive integer");
    if (opts.workspaceId !== undefined && (typeof opts.workspaceId !== "string" || !opts.workspaceId)) throw new Error("workspaceId must be a non-empty string");
    if (opts.dedupe !== undefined && typeof opts.dedupe !== "function") throw new Error("dedupe must be a function");
    if (opts.allowAnyWorkspace !== undefined && typeof opts.allowAnyWorkspace !== "boolean") throw new Error("allowAnyWorkspace must be a boolean");
    if (opts.allowAnyWorkspace === true && opts.workspaceId !== undefined) throw new Error("set workspaceId or allowAnyWorkspace, not both");
    this.allowAny = opts.allowAnyWorkspace === true;
    this.workspaceId = opts.workspaceId;
    this.dedupe = opts.dedupe;
  }

  verify(body: string, headers: Headers, nowMs: number): WebhookVerifyResult {
    const r = this.check(body, headers, nowMs);
    return r.ok ? { ok: true, eventId: r.body.id, deliveryId: r.body.delivery_id, attempt: r.body.attempt } : r;
  }

  /**
   * Verifies the request, then runs `handler` at most once per signed (workspace, event id): a re-sent capture is
   * "replayed", and a second delivery of the same event (another attempt, a replay, another endpoint sharing this
   * secret) is "duplicate". A delivery that arrives while another delivery of the same event is still being handled
   * is "in_progress" (reply 503, so it is retried and nothing is lost if the running handler then fails). The event
   * is marked processed only after the handler succeeds; if it throws, the error propagates (reply 5xx) and a later
   * delivery runs it again. Reply 2xx to "processed", "duplicate" and "replayed". Throws unless the verifier is
   * bound to a workspace (`workspaceId`) or `allowAnyWorkspace` is set.
   * A durable `dedupe` must report "in_progress" the same way (Outbox.processOnce with `reportInProgress: true`).
   */
  async receive(body: string, headers: Headers, nowMs: number, handler: (event: VerifiedEvent) => Promise<void> | void): Promise<ReceiveResult> {
    if (this.workspaceId === undefined && !this.allowAny) throw new Error("receive() needs a verifier bound to a workspace (workspaceId), or allowAnyWorkspace: true");
    const r = this.check(body, headers, nowMs);
    if (!r.ok) return r;
    const b = r.body;
    const event: VerifiedEvent = Object.freeze({ id: b.id, workspaceId: b.workspace_id, type: b.type, idempotencyKey: b.idempotency_key_scoped, createdAt: b.created_at, data: b.data });
    const run = async () => {
      await handler(event);
    };
    if (this.dedupe) {
      const outcome = await this.dedupe(b.workspace_id, b.id, run);
      if (outcome !== "processed" && outcome !== "duplicate" && outcome !== "in_progress") throw new Error("dedupe must return \"processed\", \"duplicate\" or \"in_progress\"");
      return { ok: true, outcome, eventId: b.id, workspaceId: b.workspace_id };
    }
    const key = JSON.stringify([b.workspace_id, b.id]);
    const until = this.processed.get(key);
    if (until !== undefined && until >= nowMs) return { ok: true, outcome: "duplicate", eventId: b.id, workspaceId: b.workspace_id };
    if (until !== undefined) this.processed.delete(key);
    if (this.running.has(key)) return { ok: true, outcome: "in_progress", eventId: b.id, workspaceId: b.workspace_id };
    if (this.processed.size + this.running.size >= this.maxEvents) {
      evictFront(this.processed, nowMs);
      if (this.processed.size + this.running.size >= this.maxEvents && this.processedMinExpiry < nowMs) this.processedMinExpiry = evict(this.processed, nowMs);
      if (this.processed.size + this.running.size >= this.maxEvents) return { ok: false, reason: "dedupe_cache_full" };
    }
    this.running.add(key);
    try {
      await run();
      const until = nowMs + this.retentionMs;
      this.processed.set(key, until);
      if (until < this.processedMinExpiry) this.processedMinExpiry = until;
    } finally {
      this.running.delete(key);
    }
    return { ok: true, outcome: "processed", eventId: b.id, workspaceId: b.workspace_id };
  }

  /** Number of replay-cache entries (for monitoring and tests). */
  get size(): number {
    return this.seen.size;
  }

  /** Number of event ids remembered by receive() (for monitoring and tests). */
  get processedSize(): number {
    return this.processed.size;
  }

  private check(body: string, headers: Headers, nowMs: number): { ok: true; body: Body } | { ok: false; reason: WebhookVerifyFailure } {
    const h = lowerCase(headers);
    if (!h) return { ok: false, reason: "malformed" };
    const sig = checkSignature(this.secrets, body, h[SIGNATURE_HEADER], nowMs, this.tolerance);
    if (!sig.ok) return sig;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: "malformed_body" };
    }
    const b = parsed as Body | null;
    if (
      !b || typeof b !== "object" || Array.isArray(b) ||
      typeof b.id !== "string" || !b.id || typeof b.workspace_id !== "string" || !b.workspace_id || typeof b.delivery_id !== "string" || typeof b.type !== "string" ||
      typeof b.idempotency_key !== "string" || typeof b.idempotency_key_scoped !== "string" || b.idempotency_key_scoped !== scopedIdempotencyKey(b.workspace_id, b.idempotency_key) ||
      !Number.isInteger(b.attempt) || b.attempt < 1 || !Number.isInteger(b.replay) || b.replay < 0
    )
      return { ok: false, reason: "malformed_body" };
    if (this.workspaceId !== undefined && b.workspace_id !== this.workspaceId) return { ok: false, reason: "wrong_workspace" };
    for (const [header, field] of BOUND_HEADERS) {
      const v = h[header];
      if (v !== String(b[field])) return { ok: false, reason: "header_mismatch" };
    }
    const key = JSON.stringify([b.workspace_id, b.id, b.delivery_id, b.replay, b.attempt, sig.timestamp]);
    if (this.seen.has(key)) return { ok: false, reason: "replayed" };
    if (this.seen.size >= this.maxEntries) {
      evictFront(this.seen, nowMs);
      if (this.seen.size >= this.maxEntries && this.seenMinExpiry < nowMs) this.seenMinExpiry = evict(this.seen, nowMs);
      if (this.seen.size >= this.maxEntries) return { ok: false, reason: "replay_cache_full" };
    }
    const until = (sig.timestamp + this.tolerance) * 1000 + 999;
    this.seen.set(key, until);
    if (until < this.seenMinExpiry) this.seenMinExpiry = until;
    return { ok: true, body: b };
  }
}

/** Deletes expired entries from the oldest end and stops at the first live one (entries are mostly in expiry order). Cheap. */
function evictFront(cache: Map<string, number>, nowMs: number): void {
  for (const [k, until] of cache) {
    if (until >= nowMs) return;
    cache.delete(k);
  }
}

/** Deletes every expired entry and returns the earliest remaining expiry. A full scan: only when evictFront was not enough. */
function evict(cache: Map<string, number>, nowMs: number): number {
  let min = Infinity;
  for (const [k, until] of cache) {
    if (until < nowMs) cache.delete(k);
    else if (until < min) min = until;
  }
  return min;
}

/** Lower-cases header names. A repeated (array) or non-string value makes the request malformed. */
function lowerCase(headers: Headers): Record<string, string> | null {
  if (!headers || typeof headers !== "object") return null;
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (typeof v !== "string") return null;
    const name = k.toLowerCase();
    if (name in out) return null;
    out[name] = v;
  }
  return out;
}
