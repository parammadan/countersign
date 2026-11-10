import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../../evals/dataset.mjs";
import { evaluate } from "../../evals/run.mjs";
import { resolveAnswerer, BASELINES } from "../../evals/answerers.mjs";
import type { EvalCase } from "../../evals/types";

const cases = loadCases() as EvalCase[];
const run = async (name: string) => (await evaluate(await resolveAnswerer(name, cases), cases)).overall;

describe("baselines validate the metrics", () => {
  it("oracle scores 100% on every measurable metric and leaks nothing", async () => {
    const m = await run("oracle");
    expect(m).toMatchObject({ cases: cases.length, citationAccuracy: 1, sourceRecall: 1, factualRecall: 1, factualPrecision: 1, unsupportedClaimRate: 0, abstentionPrecision: 1, abstentionRecall: 1, contradictionHandling: 1, trapLeakRate: 0 });
  });
  it("abstain: full abstention recall, poor precision, no recall of facts, no citations, no leaks", async () => {
    const m = await run("abstain");
    expect(m.abstentionRecall).toBe(1);
    expect(m.abstentionPrecision).toBeLessThan(0.2);
    expect(m.factualRecall).toBe(0);
    expect(m.citationAccuracy).toBeNull();
    expect(m.trapLeakRate).toBe(0);
  });
  it("extractive: citations are always valid, but it never abstains correctly and misses multi-source cases", async () => {
    const r = await evaluate(await resolveAnswerer("extractive", cases), cases);
    expect(r.overall.citationAccuracy).toBe(1);
    expect(r.overall.unsupportedClaimRate).toBe(0);
    expect(r.overall.abstentionRecall).toBe(0);
    expect(r.overall.factualRecall).toBeLessThan(0.5);
    expect((r.byCategory as Record<string, { sourceRecall: number | null }>).multi.sourceRecall).toBe(0);
    expect(r.overall.contradictionHandling).toBe(0);
  });
  it("adversarial: valid citations, yet every trap case leaks and is caught", async () => {
    const m = await run("adversarial");
    expect(m.trapLeakRate).toBe(1);
    expect(m.factualRecall).toBe(0);
  });
  it("is deterministic", async () => {
    for (const n of BASELINES) expect(JSON.stringify(await run(n))).toBe(JSON.stringify(await run(n)));
  });
});

describe("evaluate", () => {
  it("does not hand gold data to the answerer, and survives a throwing answerer", async () => {
    let seen: unknown;
    const spy = async (i: unknown) => { seen = i; throw new Error("boom"); };
    const r = await evaluate(spy as never, cases.slice(0, 1));
    expect(Object.keys(seen as object).sort()).toEqual(["documents", "question"]);
    expect(r.answers[0]).toMatchObject({ status: "not_found", error: "boom" });
    expect(r.overall.errors).toBe(1);
  });
  it("an answerer that always throws gets no abstention or contradiction credit", async () => {
    const r = await evaluate((async () => { throw new Error("x"); }) as never, cases);
    expect(r.overall.errors).toBe(cases.length);
    expect(r.overall.abstentionRecall).toBe(0);
    expect(r.overall.abstentionPrecision).toBeNull();
    expect(r.overall.contradictionHandling).toBe(0);
  });
  it("downgrades malformed answers to not_found", async () => {
    const r = await evaluate((async () => ({ status: "maybe", answer: 5, citations: "x" })) as never, cases.slice(0, 1));
    expect(r.answers[0]).toEqual({ status: "not_found", answer: "", citations: [] });
  });
});

describe("node evals/run.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "evals-"));
  for (const name of BASELINES) {
    it(`prints a table and writes JSON for ${name}`, () => {
      const out = join(dir, `${name}.json`);
      const stdout = execFileSync("node", ["evals/run.mjs", "--answerer", name, "--out", out], { encoding: "utf8" });
      expect(stdout).toContain(`answerer: ${name}`);
      expect(stdout).toContain("ALL");
      const json = JSON.parse(readFileSync(out, "utf8"));
      expect(json.overall.cases).toBe(cases.length);
      expect(json.answers).toHaveLength(cases.length);
      // reproducible: a second run writes byte-identical JSON
      const out2 = join(dir, `${name}-2.json`);
      execFileSync("node", ["evals/run.mjs", "--answerer", name, "--out", out2]);
      expect(readFileSync(out2, "utf8")).toBe(readFileSync(out, "utf8"));
    });
  }
  it("matches the committed baselines", () => {
    for (const name of BASELINES) {
      const out = join(dir, `chk-${name}.json`);
      execFileSync("node", ["evals/run.mjs", "--answerer", name, "--out", out]);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(join("evals/baselines", `${name}.json`), "utf8"));
    }
  });
  it("loads a custom answerer module and rejects unknown names", () => {
    const mod = join(dir, "mine.mjs");
    writeFileSync(mod, "export default async () => ({ status: 'not_found', answer: '', citations: [] });\n");
    const out = join(dir, "mine.json");
    execFileSync("node", ["evals/run.mjs", "--answerer", mod, "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf8")).answerer).toBe("mine.mjs");
    expect(() => execFileSync("node", ["evals/run.mjs", "--answerer", "gpt", "--out", join(dir, "x.json")], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("node", ["evals/run.mjs"], { stdio: "pipe" })).toThrow();
  });
});
