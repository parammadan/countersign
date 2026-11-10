import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryTransport } from "../../lib/workflow/memory-transport";
import { Outbox, type OutboxOptions, type ReplayAuthorizer } from "../../lib/workflow/outbox";
import type { Resolver } from "../../lib/workflow/net-policy";

export const SECRET = "whsec_test_secret_for_unit_tests";

export class FakeClock {
  constructor(public t = Date.UTC(2026, 0, 1)) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/** A public address the fake resolver returns by default. Nothing ever connects to it: the transport is in memory. */
export const PUBLIC_IP = "93.184.215.14";

/**
 * Fake DNS, never a real lookup. Fixed answers per name (or a function per call) win. Otherwise it models the
 * hostile names the S11 red team used: wildcard services that echo an embedded IPv4 (127.0.0.1.nip.io,
 * 169.254.169.254.example.test) answer that address, localtest.me answers 127.0.0.1, internal suffixes
 * (.corp, .lan, .home.arpa) answer 10.0.0.5; anything else answers PUBLIC_IP. Records every lookup.
 */
export function fakeResolver(answers: Record<string, readonly string[] | (() => readonly string[])> = {}) {
  const lookups: string[] = [];
  const resolve: Resolver = async (host) => {
    lookups.push(host);
    const a = answers[host];
    if (a !== undefined) return typeof a === "function" ? a() : a;
    const embedded = /(?:^|\.)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\./.exec(host);
    if (embedded) return [embedded[1]];
    if (host === "localtest.me" || host.endsWith(".localtest.me")) return ["127.0.0.1"];
    if (/\.(corp|lan|home\.arpa)$/.test(host)) return ["10.0.0.5"];
    return [PUBLIC_IP];
  };
  return Object.assign(resolve, { lookups });
}

/** Sessions the fake API layer authenticated: token -> operator, roles and workspaces. */
export const SESSIONS: Record<string, { operatorId: string; roles: string[]; workspaces: string[] }> = {
  tok_avery: { operatorId: "op_avery", roles: ["workflow_operator"], workspaces: ["ws_a", "ws_b"] },
  tok_reader: { operatorId: "op_reader", roles: ["reader"], workspaces: ["ws_a"] },
};

export const opsAuthorizer: ReplayAuthorizer = {
  authorizeReplay(credential, { workspaceId }) {
    const token = (credential as { token?: unknown } | null)?.token;
    const s = typeof token === "string" ? SESSIONS[token] : undefined;
    if (!s) return { allowed: false, reason: "unauthenticated" };
    if (!s.roles.includes("workflow_operator")) return { allowed: false, reason: "missing workflow_operator role" };
    if (!s.workspaces.includes(workspaceId)) return { allowed: false, reason: "not an operator of this workspace" };
    return { allowed: true, operatorId: s.operatorId };
  },
};

export const OPERATOR = { token: "tok_avery" };

export function setup(over: Partial<OutboxOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
  const clock = new FakeClock();
  const transport = new MemoryTransport();
  let n = 0;
  const outbox = new Outbox({
    dbPath: path.join(dir, "wf.db"),
    transport,
    clock,
    rng: () => 0.5,
    secretFor: () => SECRET,
    resolver: fakeResolver(),
    replayAuthorizer: opsAuthorizer,
    newId: (p) => `${p}_${++n}`,
    policy: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000 },
    ...over,
  });
  return { dir, clock, transport, outbox, cleanup: () => { outbox.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export const target = { id: "ep_1", url: "https://hooks.example.test/in" };
export const evt = (over: Record<string, unknown> = {}) => ({
  workspaceId: "ws_a",
  type: "file.signed",
  payload: { fileId: "file_1", client: "Jordan Sample" },
  idempotencyKey: "k1",
  ...over,
});
