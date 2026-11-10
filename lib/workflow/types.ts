// Provider-independent event and webhook reliability types. Nothing here touches lib/ or the network.

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

/** Returns a number in [0, 1). Injected so backoff jitter is deterministic in tests. */
export type Rng = () => number;

export const systemClock: Clock = { now: () => Date.now() };

export interface WorkflowEvent {
  id: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  /** sha256 hex of the canonical JSON of the payload. */
  payloadHash: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface Target {
  /** Stable id of the destination (e.g. a webhook endpoint id). The URL is kept on the delivery row only; audit records carry the target id and never the URL. */
  id: string;
  url: string;
}

export type DeliveryStatus = "pending" | "in_flight" | "delivered" | "dead";

export interface Delivery {
  id: string;
  eventId: string;
  workspaceId: string;
  targetId: string;
  targetUrl: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  lastError: string | null;
  deadReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AuditOutcome = "delivered" | "retry_scheduled" | "dead_lettered" | "replayed" | "replay_denied";

export interface AuditRecord {
  id: number;
  deliveryId: string;
  eventId: string;
  workspaceId: string;
  /** Attempt number this record is about (0 for operator actions). */
  attempt: number;
  at: number;
  outcome: AuditOutcome;
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  payloadHash: string;
  /** Verified operator id (from the replay authoriser) for replays and denied replays, otherwise null. */
  actor: string | null;
}

/**
 * The rules every transport must follow. External delivery is disabled: the only transport in this module is the
 * in-memory one. A future real (HTTP) transport must declare this contract and implement all of it:
 *  - `redirects: "never"`: a 3xx is returned as the response status and never followed (the outbox treats it as a
 *    permanent failure). Following a redirect would skip the address check below.
 *  - `connect: "pinned_address_only"`: open the TCP connection to `req.address`:`req.port` only, with no DNS
 *    lookup of its own; send `Host: req.hostHeader`; use `req.servername` for TLS SNI and certificate checks
 *    (no SNI for IP literals). No proxy, no connection reuse across different pinned addresses.
 *  - report the peer address it actually connected to as `remoteAddress`; the outbox refuses any response whose
 *    `remoteAddress` is not the pinned address.
 *  - send `req.headers` as given (the outbox has already refused values with CR, LF or other control characters),
 *    build the request line from `req.url` (already normalised), enforce `req.timeoutMs`, and abort as soon as
 *    `req.signal` fires, so an abandoned send cannot complete after the outbox has scheduled a retry.
 * The outbox checks the declaration when it is constructed and the response on every send. Those checks detect a
 * transport that breaks the contract (and dead-letter the delivery); they cannot stop bytes it already sent, so
 * the contract itself must be honoured by the implementation and covered by its own tests.
 */
export interface TransportContract {
  readonly version: 1;
  readonly redirects: "never";
  readonly connect: "pinned_address_only";
}

export const TRANSPORT_CONTRACT: TransportContract = Object.freeze({ version: 1, redirects: "never", connect: "pinned_address_only" });

export interface TransportRequest {
  /** The original URL, for the request path and logging. The transport must not resolve its host. */
  url: string;
  /** The pinned address to connect to (from resolveAndPin). */
  address: string;
  family: 4 | 6;
  port: number;
  /** Host header value: the original host. */
  hostHeader: string;
  /** TLS SNI and certificate name, or null for an IP-literal URL. */
  servername: string | null;
  /** Always "error": a transport never follows redirects. */
  redirect: "error";
  headers: Record<string, string>;
  body: string;
  /** Time left in this attempt's budget (the lookup already used part of it). */
  timeoutMs: number;
  /** Aborted when the attempt's deadline passes; the transport must stop sending and close the connection. */
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** The address the transport actually connected to; must equal `TransportRequest.address`. */
  remoteAddress: string;
}

/** A transport resolves with a response for any HTTP status, and throws TransportError for network failures. */
export interface Transport {
  readonly contract: TransportContract;
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** Throws unless `t` declares exactly the transport contract above. */
export function assertTransportContract(t: Transport): void {
  const c = (t as { contract?: Partial<TransportContract> } | null | undefined)?.contract;
  if (!t || typeof t.send !== "function" || !c || c.version !== 1 || c.redirects !== "never" || c.connect !== "pinned_address_only")
    throw new Error("transport must declare the transport contract (version 1, redirects never, pinned address only)");
}

export class TransportError extends Error {
  constructor(
    public readonly kind: "timeout" | "network",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface RetryPolicy {
  /** Total attempts allowed before dead-lettering (first try included). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 10 * 60_000 };
