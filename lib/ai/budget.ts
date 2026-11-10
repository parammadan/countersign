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
import { workspaceVerified } from "../emailverify";
import { id, now } from "../util";
import type { ModelProvider, ModelRequest, Usage as ModelUsage } from "../understand/model";
import { costMicroUsd, worstCaseMicroUsd } from "./pricing";
import { TEST_KEY } from "./anthropic";

/** claude-opus-5-5, US dollars per million tokens, for estimates; booked costs use lib/ai/pricing (cache tokens too). */
export const PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
export const DEFAULT_DAILY_USD = 5;
/** Tokens assumed per call beyond its text (message framing, schema): a margin, not a measurement. */
const OVERHEAD_TOKENS = 1_000;

export type Feature = "qa" | "m3" | "studio_suggest" | "studio_draft";
export type Usage = ModelUsage;

export const MESSAGES = {
  spendCap: "The AI assistant has reached today's spending limit; showing the passages only.",
  unverified: "Confirm your email address to use the AI assistant.",
};

type Env = Record<string, string | undefined>;
const usd = (raw: string | undefined): number | null => {
  const t = raw?.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 ? v : null;
};

/**
 * The ONE daily limit on AI spend for the whole server, every feature together. Read from AI_DAILY_USD_CAP and the
 * older AI_DAILY_BUDGET_USD (Q&A's name); when both are set the lower wins, so setting either one limits everything.
 * Anything unset, non-numeric, non-finite or negative is ignored; with neither, the default.
 */
export function dailyCapUsd(env: Env = process.env): number {
  const vs = [usd(env.AI_DAILY_USD_CAP), usd(env.AI_DAILY_BUDGET_USD)].filter((v): v is number => v !== null);
  return vs.length ? Math.min(...vs) : DEFAULT_DAILY_USD;
}
/** Per workspace per 24 hours, every feature together, so one workspace can't use up the server's limit. */
export const workspaceCapUsd = (env: Env = process.env) => usd(env.AI_WORKSPACE_DAILY_BUDGET_USD) ?? 3;
/**
 * Shared by all workspaces created in the last NEW_WORKSPACE_DAYS, every feature together. One inbox can confirm
 * many "+alias" sign-ups, so new workspaces get a smaller pool than established customers.
 */
export const newWorkspaceCapUsd = (env: Env = process.env) => usd(env.AI_NEW_WORKSPACE_DAILY_BUDGET_USD) ?? 2;
export const NEW_WORKSPACE_DAYS = 7;
/**
 * Whether AI needs a workspace whose owner confirmed their email: always, whatever the email mode (with no email
 * provider nothing can be confirmed, so nothing gets AI). Only the browser tests turn it off, and only with the test
 * key: a real key is never ungated.
 */
export const aiNeedsVerifiedWorkspace = (env: Env = process.env) => !(env.AI_ALLOW_UNVERIFIED_FOR_TESTS === "1" && env.ANTHROPIC_API_KEY === TEST_KEY);

export function costUsd(u: Usage, model = "claude-opus-5-5"): number {
  const n = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  return costMicroUsd(model, { inputTokens: n(u.inputTokens), outputTokens: n(u.outputTokens), cacheWriteTokens: n(u.cacheWriteTokens), cacheReadTokens: n(u.cacheReadTokens), model: u.model }) / 1_000_000;
}

/**
 * The most a call can cost, from its request: one token per character of input (English runs about four characters
 * per token, so this is several times too high) and the full output cap, priced as Q&A prices its worst case (the
 * model's price or a dearer one, both attempts of a server-side fallback). Replaced by the actual cost on booking.
 */
export function estimateUsd(inputChars: number, maxOutputTokens: number, model = "claude-opus-5-5"): number {
  return worstCaseMicroUsd(model, Math.max(0, inputChars) + OVERHEAD_TOKENS, Math.max(0, maxOutputTokens)) / 1e6;
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

/** Which spend to count: everything, one workspace's, or the pool of workspaces created since `newSince`. */
type Scope = { workspaceId?: string; newSince?: string };
function scoped(table: string, sc: Scope): { where: string; args: string[] } {
  if (sc.workspaceId) return { where: ` AND ${table}.workspace_id = ?`, args: [sc.workspaceId] };
  if (sc.newSince) return { where: ` AND ${table}.workspace_id IN (SELECT id FROM workspaces WHERE created_at > ?)`, args: [sc.newSince] };
  return { where: "", args: [] };
}

/** What Studio and the Knowledge Hub cost in the last 24 hours, counting calls still in flight at their reservation. */
export function meteredSpentUsd(sc: Scope = {}): number {
  ensureTable();
  const f = scoped("ai_spend", sc);
  return (
    one<{ usd: number | null }>(
      `SELECT SUM(CASE WHEN state = 'reserved' THEN reserved_usd WHEN state = 'booked' THEN cost_usd ELSE 0 END) usd FROM ai_spend WHERE created_at > ?${f.where}`,
      since(),
      ...f.args,
    )?.usd ?? 0
  );
}

/** Q&A books its own cost on each answer (qa_answers.cost_microusd, migration 7), in-flight worst cases included. */
function qaSpentUsd(sc: Scope = {}): number {
  const f = scoped("qa_answers", sc);
  return (one<{ n: number | null }>(`SELECT SUM(cost_microusd) n FROM qa_answers WHERE created_at > ?${f.where}`, since(), ...f.args)?.n ?? 0) / 1e6;
}

/** Everything every AI feature cost in the last 24 hours (or for one scope): what the limits apply to. */
export function spentUsd(sc: Scope = {}): number {
  return meteredSpentUsd(sc) + qaSpentUsd(sc);
}

const newSince = () => new Date(Date.now() - NEW_WORKSPACE_DAYS * 86400_000).toISOString();
/** Whether `estimate` more fits under every limit that applies to this workspace. Call inside the reserving transaction. */
export function fitsLimits(workspaceId: string, estimate: number, env: Env = process.env): boolean {
  if (spentUsd() + estimate > dailyCapUsd(env)) return false;
  if (spentUsd({ workspaceId }) + estimate > workspaceCapUsd(env)) return false;
  const ns = newSince();
  const isNew = !!one("SELECT 1 FROM workspaces WHERE id = ? AND created_at > ?", workspaceId, ns);
  return !isNew || spentUsd({ newSince: ns }) + estimate <= newWorkspaceCapUsd(env);
}

/** Whether a call of about this cost fits under the limit now (a hint for the UI; reserve() is the check). */
export function budgetAvailable(estimate: number, env: Env = process.env, workspaceId?: string): boolean {
  return workspaceId ? fitsLimits(workspaceId, estimate, env) : spentUsd() + estimate <= dailyCapUsd(env);
}

export type Reservation = { id: string; estimateUsd: number };

/** Takes `estimate` from today's allowance, or returns null when it doesn't fit. Atomic. */
export function reserve(o: { feature: Feature; workspaceId: string; estimateUsd: number }, env: Record<string, string | undefined> = process.env): Reservation | null {
  ensureTable();
  const estimate = Number.isFinite(o.estimateUsd) && o.estimateUsd > 0 ? o.estimateUsd : 0;
  return tx(() => {
    if (!fitsLimits(o.workspaceId, estimate, env)) return null;
    const rid = id("ais_");
    run("INSERT INTO ai_spend (id, feature, workspace_id, state, reserved_usd, created_at) VALUES (?,?,?,?,?,?)", rid, o.feature, o.workspaceId, "reserved", estimate, now());
    return { id: rid, estimateUsd: estimate };
  });
}

/** Books what the call actually cost. Also after the call settled (usage that arrived late replaces the estimate). */
export function book(r: Reservation, u: Usage, model?: string): void {
  ensureTable();
  run(
    "UPDATE ai_spend SET state = 'booked', cost_usd = ?, input_tokens = ?, output_tokens = ?, settled_at = ? WHERE id = ?",
    costUsd(u, model),
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
      const chars = req.system.length + req.document.length + (typeof req.context === "string" ? req.context.length : 0);
      const r = reserve({ ...o, estimateUsd: estimateUsd(chars, req.maxOutputTokens, inner.model) }, env);
      if (!r) {
        hit = true;
        throw new SpendCapReached();
      }
      let reported = false;
      let answered = false;
      // released only when the API refused the request outright (a 4xx is never billed); a lost connection, a 5xx or
      // anything unknown may have been billed, so it keeps its reservation as its cost
      let refused = false;
      try {
        const out = await inner.complete({
          ...req,
          onUsage: (u) => {
            reported = true;
            book(r, u, inner.model);
            req.onUsage?.(u);
          },
        });
        answered = true;
        return out;
      } catch (e) {
        const status = (e as { status?: unknown } | null)?.status;
        refused = typeof status === "number" && status >= 400 && status < 500;
        throw e;
      } finally {
        if (!reported) settle(r, answered || req.signal.aborted || !refused);
      }
    },
  };
  return { provider, capped: () => hit };
}

export type AiState = { available: true; reason?: undefined } | { available: false; reason: "off" | "unverified" | "spend_cap" };

/**
 * aiGate's rules, without a provider or a reservation: whether AI would run for this workspace now, and if not why.
 * For showing the state up front (a page can hide controls that would only fail); aiGate stays the check, at the call.
 */
export function aiState(workspaceId: string, configured: boolean, typicalUsd: number, env: Env = process.env): AiState {
  if (!configured) return { available: false, reason: "off" };
  if (aiNeedsVerifiedWorkspace(env) && !workspaceVerified(workspaceId)) return { available: false, reason: "unverified" };
  if (!budgetAvailable(typicalUsd, env, workspaceId)) return { available: false, reason: "spend_cap" };
  return { available: true };
}

export type AiGate = { provider: ModelProvider | null; reason?: "unverified" | "spend_cap"; notice?: string; capped(): boolean };

/**
 * Whether this request may use the model, and the provider to use if so (metered). With no provider configured it's
 * AI-off as before. An unconfirmed workspace, or a spent allowance, is AI-off too, with a notice saying why.
 * `typicalUsd` is a rough cost of one call of this feature, used only to decide up front.
 */
export function aiGate(feature: Feature, workspaceId: string, provider: ModelProvider | null, typicalUsd: number, env: Record<string, string | undefined> = process.env): AiGate {
  const off = { capped: () => false };
  const st = aiState(workspaceId, provider !== null, typicalUsd, env);
  if (!provider || st.reason === "off") return { provider: null, ...off };
  if (st.reason === "unverified") return { provider: null, reason: "unverified", notice: MESSAGES.unverified, ...off };
  if (st.reason === "spend_cap") return { provider: null, reason: "spend_cap", notice: MESSAGES.spendCap, capped: () => true };
  const m = metered(provider, { feature, workspaceId }, env);
  return { provider: m.provider, capped: m.capped };
}
