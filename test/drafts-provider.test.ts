import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@/lib/understand/model";
import { GENERATION_LIMITS, GenerationError, generationProvider, generationProviderFrom } from "@/lib/drafts/provider";

// Scripted providers only: nothing here reaches a real model.
function scripted(answer: (req: ModelRequest) => Promise<unknown>) {
  const calls: ModelRequest[] = [];
  const provider: ModelProvider = {
    name: "scripted",
    model: "scripted-1",
    complete: (req) => {
      calls.push(req);
      return answer(req);
    },
  };
  return { provider, calls };
}

/** The error a call rejects with (fails the test if it resolves). */
async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to fail");
}

const SCHEMA = { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } };
const REQ = { system: "You draft agreements.", prompt: "Draft a two-party NDA for Example Co.", schema: SCHEMA };

describe("generationProviderFrom", () => {
  it("maps system, prompt and schema onto a production model request", async () => {
    const { provider, calls } = scripted(async () => ({ title: "Mutual NDA" }));
    const gen = generationProviderFrom(provider, { maxOutputTokens: 1234 });
    expect(gen.name).toBe("scripted");
    await expect(gen.complete(REQ)).resolves.toEqual({ title: "Mutual NDA" });
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.system).toBe(REQ.system);
    expect(req.document).toBe(REQ.prompt);
    expect(req.schema).toBe(SCHEMA);
    expect(req.maxOutputTokens).toBe(1234);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.onUsage).toBeUndefined();
  });

  it("uses the production caps by default", async () => {
    const { provider, calls } = scripted(async () => ({}));
    await generationProviderFrom(provider).complete(REQ);
    expect(calls[0].maxOutputTokens).toBe(GENERATION_LIMITS.maxOutputTokens);
  });

  it("refuses a call without a JSON schema, before reaching the provider", async () => {
    const { provider, calls } = scripted(async () => ({}));
    const gen = generationProviderFrom(provider);
    for (const schema of [undefined, null, "object", 42, [], {}, [{ type: "object" }]]) {
      const err = await failure(gen.complete({ ...REQ, schema }));
      expect(err).toBeInstanceOf(GenerationError);
      expect(err.message).toMatch(/JSON schema is required/);
    }
    await expect(gen.complete({ system: REQ.system, prompt: REQ.prompt })).rejects.toThrow(/JSON schema is required/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an incomplete or oversized request, before reaching the provider", async () => {
    const { provider, calls } = scripted(async () => ({}));
    const gen = generationProviderFrom(provider);
    await expect(gen.complete({ ...REQ, prompt: "  " })).rejects.toThrow(/incomplete/);
    await expect(gen.complete({ ...REQ, system: undefined as unknown as string })).rejects.toThrow(/incomplete/);
    await expect(gen.complete(undefined as never)).rejects.toThrow(GenerationError);
    await expect(gen.complete({ ...REQ, prompt: "x".repeat(GENERATION_LIMITS.maxInputChars + 1) })).rejects.toThrow(/size limit/);
    expect(calls).toHaveLength(0);
  });

  it("stops a hung provider at the deadline and aborts its request", async () => {
    const { provider, calls } = scripted(() => new Promise(() => {}));
    const gen = generationProviderFrom(provider, { timeoutMs: 30 });
    const started = Date.now();
    const err = await failure(gen.complete(REQ));
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.message).toMatch(/didn't answer or was stopped/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("doesn't let a provider that resolves on abort win the race", async () => {
    const { provider } = scripted(
      (req) => new Promise((resolve) => req.signal.addEventListener("abort", () => resolve({ title: "late" }))),
    );
    await expect(generationProviderFrom(provider, { timeoutMs: 30 }).complete(REQ)).rejects.toThrow(GenerationError);
  });

  it("refuses options that would disable or break the deadline or the output cap", () => {
    const { provider } = scripted(async () => ({}));
    for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 2 ** 31]) expect(() => generationProviderFrom(provider, { timeoutMs })).toThrow(RangeError);
    for (const maxOutputTokens of [0, -5, 2.5, Infinity, 1e9]) expect(() => generationProviderFrom(provider, { maxOutputTokens })).toThrow(RangeError);
  });

  it("forwards token usage, also when the call then fails", async () => {
    const seen: unknown[] = [];
    const ok = scripted(async (req) => {
      req.onUsage?.({ inputTokens: 120, outputTokens: 45 });
      return { title: "ok" };
    });
    await generationProviderFrom(ok.provider, { onUsage: (u) => seen.push(u) }).complete(REQ);
    const bad = scripted(async (req) => {
      req.onUsage?.({ inputTokens: 300, outputTokens: 4000 });
      throw new Error("max tokens");
    });
    await expect(generationProviderFrom(bad.provider, { onUsage: (u) => seen.push(u) }).complete(REQ)).rejects.toThrow(GenerationError);
    expect(seen).toEqual([
      { inputTokens: 120, outputTokens: 45 },
      { inputTokens: 300, outputTokens: 4000 },
    ]);
  });

  it("passes on only well-formed usage counts", async () => {
    const seen: unknown[] = [];
    const { provider } = scripted(async (req) => {
      req.onUsage?.({ inputTokens: -1, outputTokens: 5 });
      req.onUsage?.({ inputTokens: NaN, outputTokens: 5 });
      req.onUsage?.({ inputTokens: "9", outputTokens: 5 } as never);
      req.onUsage?.(null as never);
      req.onUsage?.({ inputTokens: 10.7, outputTokens: 2 });
      return {};
    });
    await generationProviderFrom(provider, { onUsage: (u) => seen.push(u) }).complete(REQ);
    expect(seen).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
  });

  it("never leaks provider error text, keys or prompt content", async () => {
    const secretPrompt = "Draft for client Zephyrine Holdings, account 8812-SECRET";
    const key = "sk-ant-test-not-a-real-key";
    const throwers: (() => Promise<never>)[] = [
      async () => {
        throw new Error(`401 invalid x-api-key ${key}; request was: ${secretPrompt}`);
      },
      async () => {
        throw Object.assign(new Error(secretPrompt), { status: 500, headers: { "x-api-key": key } });
      },
      async () => {
        throw `raw string ${secretPrompt}`;
      },
    ];
    for (const t of throwers) {
      const err = await failure(generationProviderFrom(scripted(t).provider).complete({ ...REQ, prompt: secretPrompt }));
      expect(err).toBeInstanceOf(GenerationError);
      expect(err.message).toBe("The drafting service didn't answer or was stopped. Try again later.");
      const everything = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String((err as { cause?: unknown }).cause ?? "")}`;
      expect(everything).not.toContain(key);
      expect(everything).not.toContain("Zephyrine");
      expect(everything).not.toContain("invalid x-api-key");
    }
  });
});

describe("generationProvider", () => {
  it("is off unless the server configures a provider", () => {
    expect(generationProvider({}, {})).toBeNull();
    expect(generationProvider({}, { ANTHROPIC_API_KEY: "test-not-a-key" })).toBeNull();
    expect(generationProvider({}, { AI_PROVIDER: "anthropic" })).toBeNull();
    expect(generationProvider({}, { AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "test-not-a-key" })).toBeNull();
  });

  it("wraps the configured provider when there is one (no call is made)", () => {
    const gen = generationProvider({ timeoutMs: 1000 }, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-not-a-key" });
    expect(gen?.name).toBe("anthropic");
    expect(typeof gen?.complete).toBe("function");
  });
});
