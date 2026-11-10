// One spending limit for every paid model call on this server (Q&A, Agreement Studio, Knowledge Hub). Anyone can
// sign up and make a workspace, so per-workspace allowances don't bound the total; this does.
//   - reserve(): before a call, atomically (one transaction) refuses when what the last 24 hours booked, plus calls
//     still in flight, plus this call's estimate, would pass AI_DAILY_USD_CAP (default $5);
//   - book(): records the call's actual cost from its token counts, whenever they arrive (also after a timeout);
//   - a call that ends without reporting usage keeps its estimate as its cost when it may have been billed (it was
//     aborted, or it answered), and is released only when it failed outright.
// Plus the rule for who may use AI at all: only workspaces whose owner confirmed their email (when confirmation is on).
// The table is created here, at first use, so the schema migrations are untouched.
import type { DatabaseSync } from "node:sqlite";
import { db, one, run, tx } from "../db";
import { verificationRequired, workspaceVerified } from "../emailverify";
import { id, now } from "../util";
import type { ModelProvider, ModelRequest } from "../understand/model";

/** claude-opus-5-5, US dollars per million tokens. Cache reads ($0.20) are counted at the input rate: conservative. */
export const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
export const DEFAULT_DAILY_USD = 5;
/** Tokens assumed per call beyond its text (message framing, schema): a margin, not a measurement. */
const OVERHEAD_TOKENS = 1_000;

export type Feature = "qa" | "m3" | "studio_suggest" | "studio_draft";
export type Usage = { inputTokens: number; outputTokens: number };

export const MESSAGES = {
  spendCap: "The AI assistant has reached today's spending limit; showing the passages only.",
  unverified: "Confirm your email address to use the AI assistant.",
};

/** AI_DAILY_USD_CAP, read defensively: anything unset, non-numeric, non-finite or negative is the default. */
export function dailyCapUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AI_DAILY_USD_CAP?.trim();
  if (!raw) return DEFAULT_DAILY_USD;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DAILY_USD;
}

export function costUsd(u: Usage): number {
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  return (n(u.inputTokens) * PRICE.inputPerMTok + n(u.outputTokens) * PRICE.outputPerMTok) / 1_000_000;
}

/**
 * The most a call can cost, from its request: one token per character of input (English runs about four characters
 * per token, so this is several times too high) and the full output cap. Replaced by the actual cost on booking.
 */
export function estimateUsd(inputChars: number, maxOutputTokens: number): number {
  return costUsd({ inputTokens: Math.max(0, inputChars) + OVERHEAD_TOKENS, outputTokens: Math.max(0, maxOutputTokens) });
}

const prepared = new WeakSet<DatabaseSync>();
function ensureTable() {
  const d = db();
  if (prepared.has(d)) return;
  d.exec(`CREATE TABLE IF NOT EXISTS ai_spend (
    id TEXT PRIMARY KEY,
    feature TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ai_spend_created ON ai_spend (created_at);`);
  prepared.add(d);
}

const since = () => new Date(Date.now() - 86400_000).toISOString();

/** What the last 24 hours have cost, counting calls still in flight at their reservation. */
export function spentUsd(): number {
  ensureTable();
  return (
    one<{ usd: number | null }>(
      "SELECT SUM(CASE WHEN state = 'reserved' THEN reserved_usd WHEN state = 'booked' THEN cost_usd ELSE 0 END) usd FROM ai_spend WHERE created_at > ?",
      since(),
    )?.usd ?? 0
  );
}

/** Whether a call of about this cost fits under the limit now (a hint for the UI; reserve() is the check). */
export function budgetAvailable(estimate: number, env: Record<string, string | undefined> = process.env): boolean {
  return spentUsd() + estimate <= dailyCapUsd(env);
}

export type Reservation = { id: string; estimateUsd: number };

/** Takes `estimate` from today's allowance, or returns null when it doesn't fit. Atomic. */
export function reserve(o: { feature: Feature; workspaceId: string; estimateUsd: number }, env: Record<string, string | undefined> = process.env): Reservation | null {
  ensureTable();
  const cap = dailyCapUsd(env);
  const estimate = Number.isFinite(o.estimateUsd) && o.estimateUsd > 0 ? o.estimateUsd : 0;
  return tx(() => {
    if (spentUsd() + estimate > cap) return null;
    const rid = id("ais_");
    run("INSERT INTO ai_spend (id, feature, workspace_id, state, reserved_usd, created_at) VALUES (?,?,?,?,?,?)", rid, o.feature, o.workspaceId, "reserved", estimate, now());
    return { id: rid, estimateUsd: estimate };
  });
}

/** Books what the call actually cost. Also after the call settled (usage that arrived late replaces the estimate). */
export function book(r: Reservation, u: Usage): void {
  ensureTable();
  run(
    "UPDATE ai_spend SET state = 'booked', cost_usd = ?, input_tokens = ?, output_tokens = ?, settled_at = ? WHERE id = ?",
    costUsd(u),
    Math.max(0, Math.floor(u.inputTokens) || 0),
    Math.max(0, Math.floor(u.outputTokens) || 0),
    now(),
    r.id,
  );
}

/** A call that ended without reporting usage: keep the estimate if it may have been billed, else release it. */
export function settle(r: Reservation, mayHaveBilled: boolean): void {
  ensureTable();
  if (mayHaveBilled) run("UPDATE ai_spend SET state = 'booked', cost_usd = reserved_usd, settled_at = ? WHERE id = ? AND state = 'reserved'", now(), r.id);
  else run("UPDATE ai_spend SET state = 'released', settled_at = ? WHERE id = ? AND state = 'reserved'", now(), r.id);
}

/** Thrown by a metered provider when the limit is reached; callModel turns it into its fixed message. */
export class SpendCapReached extends Error {
  constructor() {
    super(MESSAGES.spendCap);
  }
}

export type Metered = { provider: ModelProvider; capped(): boolean };

/** `inner`, with every call reserved first and its cost booked. capped() says whether a call was refused. */
export function metered(inner: ModelProvider, o: { feature: Feature; workspaceId: string }, env: Record<string, string | undefined> = process.env): Metered {
  let hit = false;
  const provider: ModelProvider = {
    name: inner.name,
    model: inner.model,
    async complete(req: ModelRequest) {
      const r = reserve({ ...o, estimateUsd: estimateUsd(req.system.length + req.document.length, req.maxOutputTokens) }, env);
      if (!r) {
        hit = true;
        throw new SpendCapReached();
      }
      let reported = false;
      let answered = false;
      try {
        const out = await inner.complete({
          ...req,
          onUsage: (u) => {
            reported = true;
            book(r, u);
            req.onUsage?.(u);
          },
        });
        answered = true;
        return out;
      } finally {
        if (!reported) settle(r, answered || req.signal.aborted);
      }
    },
  };
  return { provider, capped: () => hit };
}

export type AiGate = { provider: ModelProvider | null; reason?: "unverified" | "spend_cap"; notice?: string; capped(): boolean };

/**
 * Whether this request may use the model, and the provider to use if so (metered). With no provider configured it's
 * AI-off as before. An unconfirmed workspace, or a spent allowance, is AI-off too, with a notice saying why.
 * `typicalUsd` is a rough cost of one call of this feature, used only to decide up front.
 */
export function aiGate(feature: Feature, workspaceId: string, provider: ModelProvider | null, typicalUsd: number, env: Record<string, string | undefined> = process.env): AiGate {
  const off = { capped: () => false };
  if (!provider) return { provider: null, ...off };
  if (verificationRequired() && !workspaceVerified(workspaceId)) return { provider: null, reason: "unverified", notice: MESSAGES.unverified, ...off };
  if (!budgetAvailable(typicalUsd, env)) return { provider: null, reason: "spend_cap", notice: MESSAGES.spendCap, capped: () => true };
  const m = metered(provider, { feature, workspaceId }, env);
  return { provider: m.provider, capped: m.capped };
}
