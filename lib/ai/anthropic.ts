// The one model provider AgreementOS can use: Claude through the Anthropic API (official SDK).
// Off unless the server is configured with AI_PROVIDER=anthropic AND an ANTHROPIC_API_KEY; nothing in the
// app turns it on. The provider only returns JSON; validation, evidence checks, limits and error handling
// are the callers' (lib/understand/model.ts, lib/qa/answer.ts).
import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ModelRequest } from "../understand/model";

export const AI_MODEL_DEFAULT = "claude-opus-5-5";
type Effort = "low" | "medium" | "high";

/** Thrown for a refusal, a cut-off answer or non-JSON output. Never carries provider or document text. */
export class ProviderError extends Error {}

export function configuredProvider(env: Record<string, string | undefined> = process.env): ModelProvider | null {
  if (env.AI_PROVIDER !== "anthropic" || !env.ANTHROPIC_API_KEY) return null;
  const effort = (["low", "medium", "high"] as const).find((e) => e === env.AI_EFFORT) ?? "medium";
  return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || AI_MODEL_DEFAULT, effort });
}

type Client = Pick<Anthropic, "beta">;

export function anthropicProvider(o: { apiKey?: string; model: string; effort?: Effort; client?: Client }): ModelProvider {
  // one retry for transient errors; the caller's deadline bounds the total time
  const client: Client = o.client ?? new Anthropic({ apiKey: o.apiKey, maxRetries: 1 });
  return {
    name: "anthropic",
    model: o.model,
    async complete(req: ModelRequest) {
      const res = await client.beta.messages.create(
        {
          model: o.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: "user", content: req.document }],
          output_config: { effort: o.effort ?? "medium", format: { type: "json_schema", schema: toProviderSchema(req.schema) } },
          // a policy decline is re-run server-side on Anthropic's recommended fallback model
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );
      req.onUsage?.({ inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
      if (res.stop_reason === "refusal") throw new ProviderError("The model declined this request.");
      if (res.stop_reason === "max_tokens") throw new ProviderError("The answer was cut off.");
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      try {
        return JSON.parse(text);
      } catch {
        throw new ProviderError("The answer wasn't valid JSON.");
      }
    },
  };
}

// Structured outputs accept types, enum, anyOf and additionalProperties:false, not length, range, count or
// pattern limits. Those are enforced afterwards by the caller's zod schema; here they're removed.
const UNSUPPORTED = new Set(["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "pattern", "multipleOf"]);
export function toProviderSchema(s: unknown): Record<string, unknown> {
  if (Array.isArray(s)) return s.map(toProviderSchema) as unknown as Record<string, unknown>;
  if (!s || typeof s !== "object") return s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      // ["string", "null"] -> anyOf, which structured outputs supports
      out.anyOf = v.map((t) => ({ type: t }));
      continue;
    }
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toProviderSchema(pv)])) : toProviderSchema(v);
  }
  return out;
}
