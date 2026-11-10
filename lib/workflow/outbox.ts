// Transactional outbox with idempotent publish, bounded retries, a dead-letter queue, operator replay and
// an audit trail, stored in node:sqlite (path injected). Time and randomness are injected for determinism.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { backoffDelay } from "./backoff";
import { canonicalJson, plainJsonCopy, sha256Hex } from "./canonical";
import { isInMemoryTransport } from "./memory-transport";
import { TargetRefusedError, canonicalAddress, resolveAndPin, validateTargetUrl, type PinnedTarget, type Resolver } from "./net-policy";
import { MIN_SECRET_LENGTH, SIGNATURE_HEADER, scopedIdempotencyKey, signPayload } from "./signing";
import {
  TransportError,
  assertTransportContract,
  defaultRetryPolicy,
  systemClock,
  type AuditOutcome,
  type AuditRecord,
  type Clock,
  type Delivery,
  type RetryPolicy,
  type Rng,
  type Target,
  type Transport,
  type TransportResponse,
  type WorkflowEvent,
} from "./types";

export { validateTargetUrl } from "./net-policy";

/** Event types go into the `x-workflow-event-type` header: a dotted token, no spaces or control characters. */
export const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Every header value the outbox sends must match this (printable ASCII, so no CR/LF), checked before each send. */
const SAFE_HEADER_VALUE = /^[\x20-\x7e]{1,1024}$/;
const OPERATOR_ID = /^[\x21-\x7e]{1,128}$/;
/** Workspace ids are printable ASCII without spaces, so the scoped idempotency key and the audit stay unambiguous. */
const WORKSPACE_ID = /^[\x21-\x7e]{1,128}$/;

export type ReplayDecision = { allowed: true; operatorId: string } | { allowed: false; reason: string };

/**
 * Decides whether a caller may replay a dead letter. `credential` is whatever the API layer authenticated (a
 * session, a signed token); the authoriser verifies it, checks the operator role for that workspace, and returns
 * the verified operator id, which is what the audit records. A caller-supplied name is never trusted.
 */
export interface ReplayAuthorizer {
  authorizeReplay(credential: unknown, request: { workspaceId: string; deliveryId: string }): ReplayDecision;
}

export class ReplayDeniedError extends Error {
  constructor(reason: string) {
    super(`replay denied: ${reason}`);
    this.name = "ReplayDeniedError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(key: string, what = "payload or type") {
    super(`idempotency key "${key}" was already used with a different ${what}`);
    this.name = "IdempotencyConflictError";
  }
}

export interface OutboxOptions {
  /** A database file of its own (tests), or */
  dbPath?: string;
  /** an open shared handle (the app database): the outbox then sets no PRAGMAs and never closes it. */
  db?: DatabaseSync;
  /** Must declare TRANSPORT_CONTRACT (checked here). External delivery is disabled: only MemoryTransport exists. */
  transport: Transport;
  /**
   * External delivery switch, off by default. Any transport other than the in-memory one is refused unless this
   * is exactly `true`. No network transport exists in this module; a future one must also meet TransportContract.
   */
  externalDelivery?: boolean;
  /** Resolves target host names before each send; the transport then connects to the pinned address only. */
  resolver: Resolver;
  /** Decides replays of dead letters. Without one, replay is always denied. */
  replayAuthorizer?: ReplayAuthorizer;
  /** Most replays allowed per delivery (each one grants a fresh attempt budget). Default 3. */
  maxReplays?: number;
  /**
   * Resolves the signing secret for a target of a workspace, at publish and again at send time. Secrets are never
   * stored or audited. It MUST look the target up within that workspace and return undefined for a target id the
   * workspace does not own; otherwise one workspace can name another's target id (with its own URL) and get its
   * events signed with the other workspace's secret.
   */
  secretFor: (targetId: string, workspaceId: string) => string | undefined;
  clock?: Clock;
  rng?: Rng;
  policy?: Partial<RetryPolicy>;
  timeoutMs?: number;
  /** How long a claimed delivery stays locked before another runner may take it over (crashed worker). */
  leaseMs?: number;
  newId?: (prefix: string) => string;
}

export interface PublishInput {
  workspaceId: string;
  type: string;
  payload: unknown;
  idempotencyKey: string;
}

export interface PublishResult {
  event: WorkflowEvent;
  /** True when the idempotency key was seen before: nothing new was queued. */
  duplicate: boolean;
  deliveries: Delivery[];
}

export interface RunSummary {
  attempted: number;
  delivered: number;
  retryScheduled: number;
  deadLettered: number;
}

type Row = Record<string, string | number | null>;

const MAX_ERROR_LEN = 200;
/** Largest canonical payload JSON accepted at publish (it is stored, hashed and signed on every attempt). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Every outbox table, idempotent (CREATE ... IF NOT EXISTS): safe on every start against the app database. */
export const OUTBOX_DDL = `
      CREATE TABLE IF NOT EXISTS wf_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS wf_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES wf_events(id),
        workspace_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER,
        last_error TEXT,
        dead_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (event_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS wf_deliveries_due ON wf_deliveries (status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS wf_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        duration_ms INTEGER,
        payload_hash TEXT NOT NULL,
        actor TEXT
      );
      CREATE TABLE IF NOT EXISTS wf_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        step TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wf_claims (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        consumer TEXT NOT NULL,
        token TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, event_id, consumer)
      );
      CREATE TABLE IF NOT EXISTS wf_processed (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        consumer TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, event_id, consumer)
      );
`;

export class Outbox {
  private db: DatabaseSync;
  private shared = false;
  private clock: Clock;
  private rng: Rng;
  private policy: RetryPolicy;
  private timeoutMs: number;
  private leaseMs: number;
  private newId: (prefix: string) => string;
  private maxReplays: number;

  /** A frozen copy: swapping the transport (or anything else) on the caller's options object later has no effect. */
  private readonly opts: Readonly<OutboxOptions>;

  constructor(options: OutboxOptions) {
    const opts: Readonly<OutboxOptions> = Object.freeze({ ...options });
    this.opts = opts;
    assertTransportContract(opts.transport);
    if (opts.externalDelivery !== undefined && typeof opts.externalDelivery !== "boolean") throw new Error("externalDelivery must be a boolean");
    if (!isInMemoryTransport(opts.transport) && opts.externalDelivery !== true)
      throw new Error("external delivery is disabled: only the in-memory transport may be used unless externalDelivery is true");
    if (typeof opts.resolver !== "function") throw new Error("a resolver is required");
    this.maxReplays = opts.maxReplays ?? 3;
    if (!Number.isInteger(this.maxReplays) || this.maxReplays < 0) throw new Error("maxReplays must be a non-negative integer");
    if (opts.db) {
      this.db = opts.db;
      this.shared = true;
    } else if (typeof opts.dbPath === "string" && opts.dbPath) this.db = new DatabaseSync(opts.dbPath);
    else throw new Error("a dbPath or a db handle is required");
    this.clock = opts.clock ?? systemClock;
    this.rng = opts.rng ?? Math.random;
    const defined = Object.fromEntries(Object.entries(opts.policy ?? {}).filter(([, v]) => v !== undefined));
    this.policy = { ...defaultRetryPolicy, ...defined };
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.leaseMs = opts.leaseMs ?? 60_000;
    const p = this.policy;
    if (![p.maxAttempts, p.baseDelayMs, p.maxDelayMs, this.timeoutMs, this.leaseMs].every((n) => Number.isFinite(n) && n > 0) || !Number.isInteger(p.maxAttempts))
      throw new Error("retry policy, timeoutMs and leaseMs must be positive finite numbers (maxAttempts an integer)");
    if (this.leaseMs <= this.timeoutMs) throw new Error("leaseMs must be greater than timeoutMs, or slow sends are delivered twice");
    this.newId = opts.newId ?? ((p) => `${p}_${crypto.randomUUID()}`);
    if (!this.shared) this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    // idempotent DDL only; PRAGMA user_version is never read or written (lib/db.ts owns migrations)
    this.db.exec(OUTBOX_DDL);
  }

  close(): void {
    if (!this.shared) this.db.close();
  }

  /** Events of one workspace, newest first, with how many deliveries each has and how many were delivered or dead. */
  events(workspaceId: string, limit = 100): (WorkflowEvent & { deliveries: number; delivered: number; dead: number })[] {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = this.db
      .prepare(
        `SELECT e.*, COUNT(d.id) AS deliveries, SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM wf_events e LEFT JOIN wf_deliveries d ON d.event_id = e.id AND d.workspace_id = e.workspace_id
         WHERE e.workspace_id = ? GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      )
      .all(workspaceId, n) as Row[];
    return rows.map((r) => ({ ...this.toEvent(r), deliveries: Number(r.deliveries ?? 0), delivered: Number(r.delivered ?? 0), dead: Number(r.dead ?? 0) }));
  }

  /**
   * Records an event and one delivery per target. The same (workspace, idempotencyKey) again with the same type,
   * payload and target set (any order) is a no-op that returns `duplicate`; a different type, payload or target set
   * is an IdempotencyConflictError, so a changed request is never silently dropped.
   */
  publish(input: PublishInput, targets: Target[]): PublishResult {
    if (typeof input.workspaceId !== "string" || !WORKSPACE_ID.test(input.workspaceId)) throw new Error("workspaceId must be 1-128 printable ASCII characters without spaces");
    if (typeof input.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey)) throw new Error("idempotencyKey must be 1-200 printable ASCII characters without spaces");
    if (typeof input.type !== "string" || !EVENT_TYPE_PATTERN.test(input.type)) throw new Error("type must be 1-100 characters of A-Z a-z 0-9 . _ - (it is sent as a header)");
    if (!Array.isArray(targets)) throw new Error("targets must be an array");
    const ids = new Set<string>();
    for (const t of targets) {
      if (!t || typeof t.id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(t.id) || typeof t.url !== "string") throw new Error("each target needs a printable id and a url");
      if (ids.has(t.id)) throw new Error(`target "${t.id}" is listed twice`);
      ids.add(t.id);
      const bad = validateTargetUrl(t.url);
      if (bad) throw new Error(`target "${t.id}" rejected: ${bad}`);
      // Fail fast on a missing or weak secret; it is looked up again (and checked again) at send time.
      const secret = this.opts.secretFor(t.id, input.workspaceId);
      if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) throw new Error(`target "${t.id}" rejected: signing secret missing or shorter than ${MIN_SECRET_LENGTH} characters`);
    }
    // One checked copy, one serialisation: the stored, hashed, signed and sent bodies are the same text.
    const payloadJson = canonicalJson(plainJsonCopy(input.payload));
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`payload is larger than ${MAX_PAYLOAD_BYTES} bytes as JSON`);
    const hash = sha256Hex(payloadJson);
    const now = this.clock.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM wf_events WHERE workspace_id = ? AND idempotency_key = ?")
        .get(input.workspaceId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.payload_hash !== hash || existing.type !== input.type) throw new IdempotencyConflictError(input.idempotencyKey);
        const event = this.toEvent(existing);
        const deliveries = this.deliveriesForEvent(event.id);
        const had = deliveries.map((d) => JSON.stringify([d.targetId, d.targetUrl])).sort();
        const want = targets.map((t) => JSON.stringify([t.id, t.url])).sort();
        if (had.length !== want.length || had.some((x, i) => x !== want[i])) throw new IdempotencyConflictError(input.idempotencyKey, "target list");
        this.db.exec("COMMIT");
        return { event, duplicate: true, deliveries };
      }
      const id = this.newId("evt");
      this.db
        .prepare("INSERT INTO wf_events (id, workspace_id, type, payload_json, payload_hash, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, input.workspaceId, input.type, payloadJson, hash, input.idempotencyKey, now);
      for (const t of targets) {
        this.db
          .prepare("INSERT INTO wf_deliveries (id, event_id, workspace_id, target_id, target_url, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,'pending',0,?,?,?)")
          .run(this.newId("dlv"), id, input.workspaceId, t.id, t.url, now, now, now);
      }
      const event = this.toEvent(this.db.prepare("SELECT * FROM wf_events WHERE id = ?").get(id) as Row);
      const deliveries = this.deliveriesForEvent(id);
      this.db.exec("COMMIT");
      return { event, duplicate: false, deliveries };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /** Attempts every delivery that is due (pending, or in flight with an expired lease). */
  async runDue(limit = 50): Promise<RunSummary> {
    const summary: RunSummary = { attempted: 0, delivered: 0, retryScheduled: 0, deadLettered: 0 };
    const now = this.clock.now();
    const due = this.db
      .prepare(
        "SELECT id FROM wf_deliveries WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'in_flight' AND lease_until <= ?) ORDER BY next_attempt_at, created_at, id LIMIT ?",
      )
      .all(now, now, limit) as Row[];
    for (const { id } of due) {
      const outcome = await this.attempt(String(id));
      if (!outcome) continue;
      summary.attempted++;
      if (outcome === "delivered") summary.delivered++;
      else if (outcome === "retry_scheduled") summary.retryScheduled++;
      else summary.deadLettered++;
    }
    return summary;
  }

  /** Earliest time something becomes due, or null when nothing is waiting. */
  nextDueAt(): number | null {
    const r = this.db
      .prepare("SELECT MIN(CASE WHEN status = 'in_flight' THEN lease_until ELSE next_attempt_at END) AS t FROM wf_deliveries WHERE status IN ('pending','in_flight')")
      .get() as Row;
    return r.t === null ? null : Number(r.t);
  }

  private async attempt(deliveryId: string): Promise<AuditOutcome | null> {
    const claimedAt = this.clock.now();
    const prior = this.db.prepare("SELECT * FROM wf_deliveries WHERE id = ?").get(deliveryId) as Row | undefined;
    if (!prior) return null;
    // A lease that expired on an attempt that already used the whole budget means the runner died mid-send
    // every time: dead-letter instead of retaking it forever, and audit the lost attempt.
    if (prior.status === "in_flight" && Number(prior.lease_until) <= claimedAt && Number(prior.attempts) >= this.policy.maxAttempts) {
      const d = this.rowToDelivery(prior);
      const ev = this.db.prepare("SELECT payload_hash FROM wf_events WHERE id = ?").get(d.eventId) as Row;
      return this.finish(d, d.attempts, d.leaseUntil, claimedAt, "dead_lettered", null, "lease expired", "lease expired after the final attempt (runner crashed or hung)", null, String(ev.payload_hash), 0);
    }
    // Claim: only one runner moves a due row to in_flight.
    const lease = claimedAt + this.leaseMs;
    const claimed = this.db
      .prepare(
        "UPDATE wf_deliveries SET status = 'in_flight', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'in_flight' AND lease_until <= ?))",
      )
      .run(lease, claimedAt, deliveryId, claimedAt, claimedAt);
    if (Number(claimed.changes) !== 1) return null;
    const d = this.rowToDelivery(this.db.prepare("SELECT * FROM wf_deliveries WHERE id = ?").get(deliveryId) as Row);
    const ev = this.db.prepare("SELECT * FROM wf_events WHERE id = ?").get(d.eventId) as Row;
    const body = canonicalJson({
      id: ev.id,
      type: ev.type,
      workspace_id: ev.workspace_id,
      created_at: new Date(Number(ev.created_at)).toISOString(),
      delivery_id: d.id,
      attempt: d.attempts,
      // replay generation: attempt numbers restart after a replay, so receivers key on (delivery, replay, attempt)
      replay: Number((this.db.prepare("SELECT COUNT(*) AS n FROM wf_audit WHERE delivery_id = ? AND outcome = 'replayed'").get(d.id) as Row).n),
      idempotency_key: ev.idempotency_key,
      // the header value: the tenant key scoped to the workspace (two workspaces never collide at one receiver)
      idempotency_key_scoped: scopedIdempotencyKey(String(ev.workspace_id), String(ev.idempotency_key)),
      data: JSON.parse(String(ev.payload_json)),
    });
    const secret = this.opts.secretFor(d.targetId, d.workspaceId);
    let statusCode: number | null = null;
    let error: string | null = null;
    let retryable = true;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-workflow-event-id": String(ev.id),
      "x-workflow-event-type": String(ev.type),
      "x-workflow-delivery-id": d.id,
      "x-workflow-attempt": String(d.attempts),
      "idempotency-key": scopedIdempotencyKey(String(ev.workspace_id), String(ev.idempotency_key)),
    };
    const unsafe = Object.keys(headers).find((k) => !SAFE_HEADER_VALUE.test(headers[k]));
    if (secret === undefined || secret === "") {
      error = "signing secret unavailable";
    } else if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
      error = "signing secret too short";
    } else if (unsafe) {
      // Rows written before publish validated the type (or a bad id generator) must never reach a header.
      error = `unsafe ${unsafe} header value`;
      retryable = false;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // One deadline covers the lookup and the send, so an attempt never outlives its lease.
      const startedAt = performance.now();
      const abort = new AbortController();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new TransportError("timeout", "no response"));
        }, this.timeoutMs);
        timer.unref?.();
      });
      deadline.catch(() => {});
      try {
        const resolving = resolveAndPin(d.targetUrl, this.opts.resolver);
        resolving.catch(() => {});
        const pinned: PinnedTarget = await Promise.race([resolving, deadline]);
        headers[SIGNATURE_HEADER] = signPayload(secret, body, this.clock.now());
        const sending = this.opts.transport.send({
          url: pinned.url,
          address: pinned.address,
          family: pinned.family,
          port: pinned.port,
          hostHeader: pinned.hostHeader,
          servername: pinned.servername,
          redirect: "error",
          timeoutMs: Math.max(1, Math.floor(this.timeoutMs - (performance.now() - startedAt))),
          signal: abort.signal,
          body,
          headers,
        });
        sending.catch(() => {}); // a send that loses the race below must not become an unhandled rejection
        const res: TransportResponse = await Promise.race([sending, deadline]);
        const violation = contractViolation(res, pinned);
        if (violation) {
          error = `transport contract violation: ${violation}`;
          retryable = false;
        } else {
          statusCode = res.status;
          if (res.status >= 200 && res.status < 300) error = null;
          else if (res.status >= 300 && res.status < 400) {
            error = `http ${res.status} (redirects are not followed)`;
            retryable = false;
          } else {
            error = `http ${res.status}`;
            retryable = res.status >= 500 || res.status === 408 || res.status === 429;
          }
        }
      } catch (e) {
        if (e instanceof TargetRefusedError) {
          error = `target refused: ${e.message}`;
          retryable = e.kind === "resolution";
        } else if (e instanceof TransportError) error = e.kind === "timeout" ? "timeout" : `network error: ${e.message}`;
        else error = `transport error: ${e instanceof Error ? e.message : "unknown"}`;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const finishedAt = this.clock.now();
    const safeError = error === null ? null : sanitizeError(error, secret);
    let outcome: AuditOutcome;
    let reason: string | null = null;
    let nextAt = 0;
    if (error === null) outcome = "delivered";
    else if (!retryable) {
      outcome = "dead_lettered";
      reason = `permanent failure: ${safeError}`;
    } else if (d.attempts >= this.policy.maxAttempts) {
      outcome = "dead_lettered";
      reason = `max attempts (${this.policy.maxAttempts}) exceeded: ${safeError}`;
    } else {
      outcome = "retry_scheduled";
      const delay = backoffDelay(d.attempts, this.policy, this.rng);
      if (!Number.isFinite(delay)) throw new Error("rng returned a non-finite value");
      nextAt = finishedAt + delay;
    }
    return this.finish(d, d.attempts, lease, finishedAt, outcome, statusCode, safeError, reason, nextAt, String(ev.payload_hash), Math.max(0, finishedAt - claimedAt));
  }

  /**
   * Writes the result of an attempt and its audit record in one transaction. The update only applies while the
   * row is still the same in-flight claim (same attempt number and lease), so a runner that was taken over
   * cannot overwrite the newer runner's result; it returns null and records nothing.
   */
  private finish(d: Delivery, attempt: number, lease: number | null, at: number, outcome: AuditOutcome, statusCode: number | null, error: string | null, deadReason: string | null, nextAt: number | null, hash: string, durationMs: number): AuditOutcome | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const guard = "WHERE id = ? AND status = 'in_flight' AND attempts = ? AND lease_until IS ?";
      let r;
      if (outcome === "delivered")
        r = this.db.prepare(`UPDATE wf_deliveries SET status = 'delivered', lease_until = NULL, last_error = NULL, updated_at = ? ${guard}`).run(at, d.id, attempt, lease);
      else if (outcome === "dead_lettered")
        r = this.db.prepare(`UPDATE wf_deliveries SET status = 'dead', lease_until = NULL, last_error = ?, dead_reason = ?, updated_at = ? ${guard}`).run(error, deadReason, at, d.id, attempt, lease);
      else
        r = this.db.prepare(`UPDATE wf_deliveries SET status = 'pending', next_attempt_at = ?, lease_until = NULL, last_error = ?, updated_at = ? ${guard}`).run(nextAt, error, at, d.id, attempt, lease);
      if (Number(r.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.writeAudit(d, attempt, at, outcome, statusCode, error, durationMs, hash, null);
      this.db.exec("COMMIT");
      return outcome;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /**
   * Operator action: puts a dead-lettered delivery back in the queue with a fresh attempt budget. `credential` is
   * passed to the injected ReplayAuthorizer, which must allow it and name the verified operator; without an
   * authoriser every replay is denied. Each delivery may be replayed at most `maxReplays` times. Denials of an
   * existing delivery are audited as `replay_denied`.
   */
  replay(workspaceId: string, deliveryId: string, credential: unknown): Delivery {
    let decision: ReplayDecision;
    try {
      decision = this.opts.replayAuthorizer
        ? this.opts.replayAuthorizer.authorizeReplay(credential, { workspaceId, deliveryId })
        : { allowed: false, reason: "no replay authoriser configured" };
    } catch {
      decision = { allowed: false, reason: "authoriser error" };
    }
    if (decision && typeof (decision as { then?: unknown }).then === "function") decision = { allowed: false, reason: "authoriser must be synchronous" };
    if (!decision || typeof decision !== "object") decision = { allowed: false, reason: "authoriser returned no decision" };
    if (decision.allowed === true && (typeof decision.operatorId !== "string" || !OPERATOR_ID.test(decision.operatorId)))
      decision = { allowed: false, reason: "authoriser returned an invalid operator id" };
    if (decision.allowed !== true) {
      const reason = typeof decision.reason === "string" && decision.reason ? sanitizeError(decision.reason) : "not authorised";
      this.auditDenial(workspaceId, deliveryId, null, reason);
      throw new ReplayDeniedError(reason);
    }
    const actor = decision.operatorId;
    const now = this.clock.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replays = this.db.prepare("SELECT COUNT(*) AS n FROM wf_audit WHERE delivery_id = ? AND workspace_id = ? AND outcome = 'replayed'").get(deliveryId, workspaceId) as Row;
      const dead = this.db.prepare("SELECT 1 FROM wf_deliveries WHERE id = ? AND workspace_id = ? AND status = 'dead'").get(deliveryId, workspaceId);
      if (dead && Number(replays.n) >= this.maxReplays) {
        this.db.exec("ROLLBACK");
        const reason = `replay limit (${this.maxReplays}) reached`;
        this.auditDenial(workspaceId, deliveryId, actor, reason);
        throw new ReplayDeniedError(reason);
      }
      const r = this.db
        .prepare("UPDATE wf_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, dead_reason = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'dead'")
        .run(now, now, deliveryId, workspaceId);
      if (Number(r.changes) !== 1) {
        this.db.exec("ROLLBACK");
        this.auditDenial(workspaceId, deliveryId, actor, "delivery is not dead-lettered");
        throw new Error("delivery not found in this workspace's dead-letter queue");
      }
      const d = this.getDelivery(workspaceId, deliveryId)!;
      const ev = this.db.prepare("SELECT payload_hash FROM wf_events WHERE id = ?").get(d.eventId) as Row;
      this.writeAudit(d, 0, now, "replayed", null, null, null, String(ev.payload_hash), actor);
      this.db.exec("COMMIT");
      return d;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /**
   * Audits a refused replay of a delivery that exists in this workspace. Unknown ids, and ids of another
   * workspace, are not recorded here (the audit is per workspace); the API layer should log those denials.
   */
  private auditDenial(workspaceId: string, deliveryId: string, actor: string | null, reason: string): void {
    const d = this.getDelivery(workspaceId, deliveryId);
    if (!d) return;
    const ev = this.db.prepare("SELECT payload_hash FROM wf_events WHERE id = ?").get(d.eventId) as Row;
    this.writeAudit(d, 0, this.clock.now(), "replay_denied", null, reason, null, String(ev.payload_hash), actor);
  }

  deadLetters(workspaceId: string): Delivery[] {
    return (this.db.prepare("SELECT * FROM wf_deliveries WHERE workspace_id = ? AND status = 'dead' ORDER BY updated_at, id").all(workspaceId) as Row[]).map((r) => this.rowToDelivery(r));
  }

  getDelivery(workspaceId: string, deliveryId: string): Delivery | null {
    const r = this.db.prepare("SELECT * FROM wf_deliveries WHERE id = ? AND workspace_id = ?").get(deliveryId, workspaceId) as Row | undefined;
    return r ? this.rowToDelivery(r) : null;
  }

  audit(workspaceId: string, deliveryId?: string): AuditRecord[] {
    const rows = (
      deliveryId
        ? this.db.prepare("SELECT * FROM wf_audit WHERE workspace_id = ? AND delivery_id = ? ORDER BY id").all(workspaceId, deliveryId)
        : this.db.prepare("SELECT * FROM wf_audit WHERE workspace_id = ? ORDER BY id").all(workspaceId)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      deliveryId: String(r.delivery_id),
      eventId: String(r.event_id),
      workspaceId: String(r.workspace_id),
      attempt: Number(r.attempt),
      at: Number(r.at),
      outcome: r.outcome as AuditOutcome,
      statusCode: r.status_code === null ? null : Number(r.status_code),
      error: r.error === null ? null : String(r.error),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      payloadHash: String(r.payload_hash),
      actor: r.actor === null ? null : String(r.actor),
    }));
  }

  /**
   * Consumer-side idempotency. The event is marked processed only after the handler succeeds. While a handler
   * runs, a short-lived claim (lease) makes a concurrent duplicate return "duplicate" instead of running twice.
   * If the handler throws, the claim is released so a retry runs it again; if the process dies mid-handler the
   * claim expires after `leaseMs` and the event is run again (at-least-once), so handlers must be safe to repeat.
   * With `reportInProgress`, a call that finds a live claim (another run still in progress) but no processed mark
   * returns "in_progress" instead of "duplicate", so a webhook receiver can reply 503 and get the delivery retried
   * (if the running handler then fails, the retry runs it; a 2xx "duplicate" would lose the event).
   */
  async processOnce(
    workspaceId: string,
    eventId: string,
    consumer: string,
    handler: () => Promise<void> | void,
    opts: { reportInProgress?: boolean } = {},
  ): Promise<"processed" | "duplicate" | "in_progress"> {
    const token = this.newId("clm");
    const now = this.clock.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const done = this.db.prepare("SELECT 1 FROM wf_processed WHERE workspace_id = ? AND event_id = ? AND consumer = ?").get(workspaceId, eventId, consumer);
      const claim = this.db.prepare("SELECT lease_until FROM wf_claims WHERE workspace_id = ? AND event_id = ? AND consumer = ?").get(workspaceId, eventId, consumer) as Row | undefined;
      if (done || (claim && Number(claim.lease_until) > now)) {
        this.db.exec("COMMIT");
        return !done && opts.reportInProgress === true ? "in_progress" : "duplicate";
      }
      this.db
        .prepare("INSERT OR REPLACE INTO wf_claims (workspace_id, event_id, consumer, token, lease_until) VALUES (?,?,?,?,?)")
        .run(workspaceId, eventId, consumer, token, now + this.leaseMs);
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    const release = () => this.db.prepare("DELETE FROM wf_claims WHERE workspace_id = ? AND event_id = ? AND consumer = ? AND token = ?").run(workspaceId, eventId, consumer, token);
    try {
      await handler();
    } catch (e) {
      try {
        release();
      } catch {
        /* keep the handler's error */
      }
      throw e;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO wf_processed (workspace_id, event_id, consumer, processed_at) VALUES (?,?,?,?)").run(workspaceId, eventId, consumer, this.clock.now());
      release();
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    return "processed";
  }

  /** Pipeline-level audit: one row per step (intake received, routed, verified, published, blocked). `detail` must carry no document text. */
  recordStep(workspaceId: string, subjectId: string, step: string, outcome: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO wf_steps (workspace_id, subject_id, step, outcome, detail, at) VALUES (?,?,?,?,?,?)")
      .run(workspaceId, subjectId, step, outcome, canonicalJson(detail), this.clock.now());
  }

  steps(workspaceId: string, subjectId?: string): { step: string; outcome: string; detail: Record<string, unknown>; at: number }[] {
    const rows = (subjectId === undefined
      ? this.db.prepare("SELECT * FROM wf_steps WHERE workspace_id = ? ORDER BY id").all(workspaceId)
      : this.db.prepare("SELECT * FROM wf_steps WHERE workspace_id = ? AND subject_id = ? ORDER BY id").all(workspaceId, subjectId)) as Row[];
    return rows.map((r) => ({ step: String(r.step), outcome: String(r.outcome), detail: JSON.parse(String(r.detail)), at: Number(r.at) }));
  }

  private writeAudit(d: Delivery, attempt: number, at: number, outcome: AuditOutcome, statusCode: number | null, error: string | null, durationMs: number | null, hash: string, actor: string | null): void {
    this.db
      .prepare("INSERT INTO wf_audit (delivery_id, event_id, workspace_id, attempt, at, outcome, status_code, error, duration_ms, payload_hash, actor) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(d.id, d.eventId, d.workspaceId, attempt, at, outcome, statusCode, error, durationMs, hash, actor);
  }

  private deliveriesForEvent(eventId: string): Delivery[] {
    return (this.db.prepare("SELECT * FROM wf_deliveries WHERE event_id = ? ORDER BY created_at, id").all(eventId) as Row[]).map((r) => this.rowToDelivery(r));
  }

  private toEvent(r: Row): WorkflowEvent {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      type: String(r.type),
      payload: JSON.parse(String(r.payload_json)),
      payloadHash: String(r.payload_hash),
      idempotencyKey: String(r.idempotency_key),
      createdAt: Number(r.created_at),
    };
  }

  private rowToDelivery(r: Row): Delivery {
    return {
      id: String(r.id),
      eventId: String(r.event_id),
      workspaceId: String(r.workspace_id),
      targetId: String(r.target_id),
      targetUrl: String(r.target_url),
      status: r.status as Delivery["status"],
      attempts: Number(r.attempts),
      nextAttemptAt: Number(r.next_attempt_at),
      leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
      lastError: r.last_error === null ? null : String(r.last_error),
      deadReason: r.dead_reason === null ? null : String(r.dead_reason),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}

/** Returns why a transport response breaks the transport contract, or null when it is acceptable. */
function contractViolation(res: TransportResponse, pinned: PinnedTarget): string | null {
  if (!res || typeof res !== "object" || !Number.isInteger(res.status) || res.status < 100 || res.status > 599) return "invalid response";
  const remote = typeof res.remoteAddress === "string" ? canonicalAddress(res.remoteAddress.replace(/^::ffff:(?=\d+\.)/i, "")) : null;
  if (!remote || remote.address !== pinned.address) return "connected to an address other than the pinned one";
  return null;
}

/** Keeps audit errors short and free of the signing secret or bearer-style tokens. */
export function sanitizeError(message: string, secret?: string): string {
  let m = message;
  if (typeof secret === "string" && secret) m = m.split(secret).join("[redacted]");
  m = m.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1?[redacted]").replace(/\/\/[^\s/@]+@/g, "//[redacted]@");
  m = m.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bwhsec_\S+/g, "[redacted]");
  return m.length > MAX_ERROR_LEN ? `${m.slice(0, MAX_ERROR_LEN)}…` : m;
}
