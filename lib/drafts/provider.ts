// Adapter from production's model layer to the interface the M2.3 draft generator expects
// ({ name, complete({ system, prompt, schema }) }). Nothing calls it yet. Every call goes through callModel, so
// it gets the same guarantees as M2.1 and M2.2:
//   - a deadline: the request is aborted and the call rejects when it runs out, so a hung provider can't leave
//     a generation pending forever;
//   - an output-token cap and an input cap, so cost is bounded;
//   - structured output only: a call without a JSON schema is refused before the provider is reached;
//   - token counts go to onUsage, so the caller can book what the call cost (also when it failed);
//   - every failure becomes one fixed message, because provider errors can echo the request, and so the prompt.
// AI stays off by default: generationProvider() is null unless the server configures a provider.
import { callModel, LIMITS, type ModelProvider } from "../understand/model";
import { configuredProvider } from "../ai/anthropic";

export type GenerationRequest = { system: string; prompt: string; schema?: unknown };

/** What the M2.3 generator calls (same shape as the sandbox's provider interface). */
export interface GenerationProvider {
  name: string;
  complete(req: GenerationRequest): Promise<unknown>;
}

export type Usage = { inputTokens: number; outputTokens: number };

export type GenerationOptions = {
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** called with the token counts of each call, for cost tracking; may come after a timeout, since tokens were still spent */
  onUsage?: (u: Usage) => void;
};

export const GENERATION_LIMITS = { maxInputChars: LIMITS.maxInputChars, maxOutputTokens: LIMITS.maxOutputTokens, timeoutMs: LIMITS.timeoutMs };

/** The only error complete() throws; its message is one of the fixed ones below, never provider or prompt text. */
export class GenerationError extends Error {}

const MSG = {
  schema: "A JSON schema is required for every generation call.",
  request: "The generation request is incomplete.",
  tooLong: "The generation request is over the size limit.",
  failed: "The drafting service didn't answer or was stopped. Try again later.",
};

// setTimeout treats anything above 2^31-1 ms (or a non-finite value) as 1 ms, which would make the deadline meaningless
const MAX_TIMER_MS = 2 ** 31 - 1;

function positiveInt(v: number | undefined, fallback: number, max: number, what: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`${what} must be an integer from 1 to ${max}.`);
  return v;
}

function isSchema(s: unknown): s is Record<string, unknown> {
  return typeof s === "object" && s !== null && !Array.isArray(s) && Object.keys(s).length > 0;
}

/** Only finite, non-negative whole counts are passed on; a provider can't book garbage. */
function cleanUsage(u: unknown): Usage | null {
  if (typeof u !== "object" || u === null) return null;
  const { inputTokens, outputTokens } = u as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
  const i = n(inputTokens);
  const o = n(outputTokens);
  return i === null || o === null ? null : { inputTokens: i, outputTokens: o };
}

export function generationProviderFrom(provider: ModelProvider, opts: GenerationOptions = {}): GenerationProvider {
  // bad options are a programming error, caught when the adapter is made, not at call time
  const maxOutputTokens = positiveInt(opts.maxOutputTokens, GENERATION_LIMITS.maxOutputTokens, 64_000, "maxOutputTokens");
  const timeoutMs = positiveInt(opts.timeoutMs, GENERATION_LIMITS.timeoutMs, MAX_TIMER_MS, "timeoutMs");
  const onUsage = opts.onUsage;
  return {
    name: provider.name,
    async complete(req: GenerationRequest): Promise<unknown> {
      const { system, prompt, schema } = (req ?? {}) as Partial<GenerationRequest>;
      if (!isSchema(schema)) throw new GenerationError(MSG.schema);
      if (typeof system !== "string" || typeof prompt !== "string" || !prompt.trim()) throw new GenerationError(MSG.request);
      if (system.length + prompt.length > GENERATION_LIMITS.maxInputChars) throw new GenerationError(MSG.tooLong);
      try {
        return await callModel(
          provider,
          {
            system,
            document: prompt,
            schema,
            maxOutputTokens,
            onUsage: onUsage
              ? (u) => {
                  const clean = cleanUsage(u);
                  if (clean) onUsage(clean);
                }
              : undefined,
          },
          timeoutMs,
        );
      } catch {
        // callModel already replaces provider errors with fixed text; this keeps one message for the generator
        throw new GenerationError(MSG.failed);
      }
    },
  };
}

/** The generation provider for this server, or null when no model is configured (the default). */
export function generationProvider(opts: GenerationOptions = {}, env: Record<string, string | undefined> = process.env): GenerationProvider | null {
  const provider = configuredProvider(env);
  return provider ? generationProviderFrom(provider, opts) : null;
}
