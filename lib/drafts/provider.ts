// Adapter from production's model layer to the interface the M2.3 draft generator expects
// ({ name, complete({ system, prompt, schema }) }). Nothing calls it yet. Every call goes through callModel, so
// it gets the same guarantees as M2.1 and M2.2:
//   - a deadline: the request is aborted and the call rejects when it runs out, so a hung provider can't leave
//     a generation pending forever;
//   - an output-token cap and an input cap, so cost is bounded; options can tighten the production limits, and
//     the output cap can be raised only up to a fixed ceiling (a draft is longer than an M2.1 answer);
//   - structured output only: a call without a JSON object schema is refused before the provider is reached;
//   - token counts go to onUsage, and a failed call's counts are also on the error, so the caller can book what
//     each call cost;
//   - every failure becomes one fixed message, because provider errors can echo the request, and so the prompt.
// The answer is NOT validated here: the provider is asked to follow the schema, but (as in M2.1 and M2.2) the
// caller must parse the result with its own zod schema before using it.
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
  /**
   * Called with the token counts of each call, for cost tracking. It may come after a timeout (the tokens were
   * still spent). If it throws, the call fails: a cost that can't be booked doesn't pass silently.
   */
  onUsage?: (u: Usage) => void;
};

export const GENERATION_LIMITS = {
  maxInputChars: LIMITS.maxInputChars,
  /** default output cap, production's */
  maxOutputTokens: LIMITS.maxOutputTokens,
  /** the most an option may raise it to: room for a full agreement draft, still a bounded cost per call */
  maxOutputTokensCeiling: 16_000,
  /** production's deadline; an option may shorten it, never lengthen it */
  timeoutMs: LIMITS.timeoutMs,
};

/** The only error complete() throws; its message is one of the fixed ones below, never provider or prompt text. */
export class GenerationError extends Error {
  /** what the failed call cost, when the provider reported it before failing */
  constructor(message: string, readonly usage?: Usage) {
    super(message);
  }
}

const MSG = {
  schema: "A JSON schema is required for every generation call.",
  request: "The generation request is incomplete.",
  tooLong: "The generation request is over the size limit.",
  failed: "The drafting service didn't answer or was stopped. Try again later.",
};

function positiveInt(v: number | undefined, fallback: number, max: number, what: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`${what} must be an integer from 1 to ${max}.`);
  return v;
}

/** A JSON Schema for an object answer, which is what structured output takes at the root. */
function isSchema(s: unknown): s is Record<string, unknown> {
  return typeof s === "object" && s !== null && !Array.isArray(s) && (s as Record<string, unknown>).type === "object";
}

/** Only finite, non-negative whole counts are passed on; a provider can't book garbage. */
function cleanUsage(u: unknown): Usage | null {
  if (typeof u !== "object" || u === null) return null;
  const { inputTokens, outputTokens } = u as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && x >= 0 && Number.isSafeInteger(Math.floor(x)) ? Math.floor(x) : null);
  const i = n(inputTokens);
  const o = n(outputTokens);
  return i === null || o === null ? null : { inputTokens: i, outputTokens: o };
}

/** The request's fields, checked; anything wrong (including a getter that throws) becomes a fixed message. */
function checked(req: GenerationRequest): { system: string; prompt: string; schema: Record<string, unknown> } {
  let system: unknown, prompt: unknown, schema: unknown;
  try {
    ({ system, prompt, schema } = (req ?? {}) as Partial<GenerationRequest>);
  } catch {
    throw new GenerationError(MSG.request);
  }
  if (!isSchema(schema)) throw new GenerationError(MSG.schema);
  if (typeof system !== "string" || typeof prompt !== "string" || !prompt.trim()) throw new GenerationError(MSG.request);
  if (system.length + prompt.length > GENERATION_LIMITS.maxInputChars) throw new GenerationError(MSG.tooLong);
  return { system, prompt, schema };
}

export function generationProviderFrom(provider: ModelProvider, opts: GenerationOptions = {}): GenerationProvider {
  // bad options are a programming error, caught when the adapter is made, not at call time
  const o = opts ?? {};
  const maxOutputTokens = positiveInt(o.maxOutputTokens, GENERATION_LIMITS.maxOutputTokens, GENERATION_LIMITS.maxOutputTokensCeiling, "maxOutputTokens");
  const timeoutMs = positiveInt(o.timeoutMs, GENERATION_LIMITS.timeoutMs, GENERATION_LIMITS.timeoutMs, "timeoutMs");
  const onUsage = o.onUsage;
  return {
    name: provider.name,
    async complete(req: GenerationRequest): Promise<unknown> {
      const { system, prompt, schema } = checked(req);
      let usage: Usage | undefined; // this call's, so a failure can carry it
      try {
        return await callModel(
          provider,
          {
            system,
            document: prompt,
            schema,
            maxOutputTokens,
            onUsage: (u) => {
              const clean = cleanUsage(u);
              if (!clean) return;
              usage = clean;
              onUsage?.(clean);
            },
          },
          timeoutMs,
        );
      } catch {
        // callModel already replaces provider errors with fixed text; this keeps one message for the generator,
        // with no cause attached
        throw new GenerationError(MSG.failed, usage);
      }
    },
  };
}

/** The generation provider for this server, or null when no model is configured (the default). */
export function generationProvider(opts: GenerationOptions = {}, env: Record<string, string | undefined> = process.env): GenerationProvider | null {
  const provider = configuredProvider(env);
  return provider ? generationProviderFrom(provider, opts) : null;
}
