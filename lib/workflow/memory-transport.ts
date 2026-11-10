// In-memory transport for tests: scripted responses, failures and timeouts. Never touches the network.
import { TRANSPORT_CONTRACT, TransportError, type Transport, type TransportRequest, type TransportResponse } from "./types";

/** A status (optionally with the address the fake "connected" to, to test the contract check), or a failure. */
export type Script = { status: number; remoteAddress?: string } | "timeout" | "network";

/** Instances created by the MemoryTransport constructor. The outbox refuses every other transport unless external delivery is switched on. */
const inMemory = new WeakSet<object>();

/**
 * True only for a MemoryTransport instance whose `send` is the in-memory one (not overridden by a subclass or
 * replaced on the instance), so nothing it sends leaves the process.
 */
export function isInMemoryTransport(t: unknown): boolean {
  return typeof t === "object" && t !== null && inMemory.has(t) && (t as { send?: unknown }).send === MemoryTransport.prototype.send;
}

export class MemoryTransport implements Transport {
  readonly contract = TRANSPORT_CONTRACT;
  readonly requests: TransportRequest[] = [];
  private queue: Script[] = [];
  constructor(private fallback: Script = { status: 200 }) {
    inMemory.add(this);
  }

  /** Next responses, consumed in order; after they run out the fallback is used. */
  script(...next: Script[]): this {
    this.queue.push(...next);
    return this;
  }

  setFallback(s: Script): this {
    this.fallback = s;
    return this;
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const s = this.queue.length ? this.queue.shift()! : this.fallback;
    if (s === "timeout") throw new TransportError("timeout", `timed out after ${req.timeoutMs}ms`);
    if (s === "network") throw new TransportError("network", "connection refused");
    return { status: s.status, remoteAddress: s.remoteAddress ?? req.address };
  }
}
