// Document-understanding evaluation (M2.1): synthetic agreements with ground truth, a pluggable analyzer,
// and a printed score table. The first honest measurement, so it asserts only invariants, never score floors.
//
//   npx vitest run test/understand-eval.test.ts
//   UNDERSTAND_ANALYZER=./path/to/module.ts npx vitest run test/understand-eval.test.ts   (module default-exports an Analyzer)
//
// Cases: fixtures/understanding/*.json (see scripts/make-understanding.mjs for the PDFs). Every case runs on
// its plain-text pages; cases with a .pdf also run through extractPdf -> pageLines (the real upload path).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractPdf } from "@/lib/pdf/extract";
import { documentTitle } from "@/lib/pdf/title";
import { analyzeWithRules } from "@/lib/understand/rules";
import { groundFindings, normalize } from "@/lib/understand/evidence";
import { linesFromText, pageLines, pageText, type PageLines } from "@/lib/understand/text";
import { AnalyzerOutputSchema, CATEGORIES, FindingSchema, STATUSES, type Category, type Finding, type Status } from "@/lib/understand/schema";

export type EvalInput = { pages: PageLines[]; title?: string | null; fields?: unknown[] };
/** Anything that reads an agreement and returns findings. Evidence checking is applied by the harness. */
export type Analyzer = (input: EvalInput) => Finding[] | Promise<Finding[]>;

export type Expect = { category: Category; label?: string; status: Status; value?: string; page?: number };
export type Trap = { value: string; note: string };
export type EvalCase = {
  name: string;
  description?: string;
  pages: string[];
  title?: string;
  fields?: unknown[];
  expect: Expect[];
  traps: Trap[];
  pdf?: boolean;
};

/** Default analyzer: the built-in rules, then the evidence check, exactly as the product runs them. */
export const rulesAnalyzer: Analyzer = (input) => {
  const out = AnalyzerOutputSchema.parse(analyzeWithRules(input as Parameters<typeof analyzeWithRules>[0]));
  return groundFindings(out.findings, input.pages).findings;
};

const DIR = path.join(import.meta.dirname, "..", "fixtures", "understanding");

export function loadCases(dir = DIR): EvalCase[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalCase);
}

const squash = (s: string) => normalize(s).replace(/[^a-z0-9%$]+/g, "");

/** Does this finding answer this expectation? Category plus value, else plus label; with neither, plus status (the only handle left). */
export function answers(f: Finding, x: Expect): boolean {
  if (f.category !== x.category) return false;
  if (x.value) return squash(f.value ?? "").includes(squash(x.value)) || f.evidence.some((e) => squash(e.quote).includes(squash(x.value!)));
  if (x.label) return normalize(`${f.label} ${f.note ?? ""} ${f.value ?? ""} ${f.evidence.map((e) => e.quote).join(" ")}`).includes(normalize(x.label));
  return f.status === x.status;
}

export type ExpectResult = { x: Expect; found: boolean; statusOk: boolean; pageOk: boolean | null; got?: Finding };

export function scoreCase(c: EvalCase, findings: Finding[]) {
  const results: ExpectResult[] = c.expect.map((x) => {
    const hits = findings.filter((f) => answers(f, x));
    // prefer a hit with the right status, so one wrong sibling doesn't mask a right one
    const got = hits.find((f) => f.status === x.status) ?? hits[0];
    return {
      x,
      found: !!got,
      statusOk: !!got && got.status === x.status,
      pageOk: x.page && got && got.evidence.length ? got.evidence.some((e) => e.page === x.page) : null,
      got,
    };
  });
  const violations = c.traps.flatMap((t) =>
    findings.filter((f) => f.status === "stated" && squash(`${f.label} ${f.value ?? ""}`).includes(squash(t.value))).map((f) => ({ trap: t, finding: f })),
  );
  return { results, violations };
}

type Row = { name: string; source: "text" | "pdf"; findings: Finding[]; results: ExpectResult[]; violations: ReturnType<typeof scoreCase>["violations"]; pages: PageLines[] };

export async function runEval(analyzer: Analyzer, cases: EvalCase[], dir = DIR): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const textPages = linesFromText(c.pages);
    const variants: { source: "text" | "pdf"; pages: PageLines[]; title: string | null }[] = [{ source: "text", pages: textPages, title: c.title ?? null }];
    const pdfPath = path.join(dir, `${c.name}.pdf`);
    if (c.pdf && fs.existsSync(pdfPath)) {
      const ex = await extractPdf(new Uint8Array(fs.readFileSync(pdfPath)));
      variants.push({ source: "pdf", pages: pageLines(ex), title: documentTitle(ex) });
    }
    for (const v of variants) {
      const findings = await analyzer({ pages: v.pages, title: v.title, fields: c.fields });
      rows.push({ name: c.name, source: v.source, findings, pages: v.pages, ...scoreCase(c, findings) });
    }
  }
  return rows;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%`.padStart(4) : "   -");

export function report(rows: Row[]): string {
  const out: string[] = [];
  const cell = (s: string, w: number) => s.padEnd(w).slice(0, w);
  for (const source of ["text", "pdf"] as const) {
    const sel = rows.filter((r) => r.source === source);
    if (!sel.length) continue;
    out.push(`\n== ${source.toUpperCase()} input: ${sel.length} cases ==`);
    out.push(`${cell("category", 12)} ${"expect".padStart(6)} ${"found".padStart(6)} ${"recall".padStart(6)} ${"status ok".padStart(9)} ${"status acc".padStart(10)} ${"page acc".padStart(9)}`);
    let tn = 0, tf = 0, ts = 0, tp = 0, tpn = 0;
    for (const cat of CATEGORIES) {
      const rs = sel.flatMap((r) => r.results).filter((r) => r.x.category === cat);
      const n = rs.length, f = rs.filter((r) => r.found).length, s = rs.filter((r) => r.statusOk).length;
      const pg = rs.filter((r) => r.pageOk !== null), pgOk = pg.filter((r) => r.pageOk).length;
      tn += n; tf += f; ts += s; tp += pgOk; tpn += pg.length;
      out.push(`${cell(cat, 12)} ${String(n).padStart(6)} ${String(f).padStart(6)} ${pct(f, n).padStart(6)} ${String(s).padStart(9)} ${pct(s, f).padStart(10)} ${pct(pgOk, pg.length).padStart(9)}`);
    }
    out.push(`${cell("ALL", 12)} ${String(tn).padStart(6)} ${String(tf).padStart(6)} ${pct(tf, tn).padStart(6)} ${String(ts).padStart(9)} ${pct(ts, tf).padStart(10)} ${pct(tp, tpn).padStart(9)}`);
    out.push(`trap violations (a trap value reported as stated): ${sel.reduce((a, r) => a + r.violations.length, 0)}`);
    out.push("");
    out.push(`${cell("case", 26)} ${"expect".padStart(6)} ${"found".padStart(6)} ${"status ok".padStart(9)} ${"traps".padStart(6)} findings`);
    for (const r of sel) out.push(`${cell(r.name, 26)} ${String(r.results.length).padStart(6)} ${String(r.results.filter((x) => x.found).length).padStart(6)} ${String(r.results.filter((x) => x.statusOk).length).padStart(9)} ${String(r.violations.length).padStart(6)} ${r.findings.length}`);
  }
  return out.join("\n");
}

/** Every expectation that was missed or got the wrong status, with the line in the case where it should be found. */
export function misses(rows: Row[], cases: EvalCase[]) {
  const out: { name: string; source: string; x: Expect; problem: string; line: string }[] = [];
  for (const r of rows) {
    const c = cases.find((k) => k.name === r.name)!;
    for (const res of r.results) {
      if (res.found && res.statusOk) continue;
      const needle = res.x.value ? squash(res.x.value) : "";
      let line = "";
      const pages = linesFromText(c.pages);
      for (const p of pages) for (let i = 0; i < p.lines.length; i++) if (needle && squash(p.lines[i]).includes(needle) && !line) line = `p${p.page} line ${i + 1}: ${p.lines[i]}`;
      out.push({ name: r.name, source: r.source, x: res.x, problem: res.found ? `status ${res.got!.status}, expected ${res.x.status}` : "not reported", line });
    }
  }
  return out;
}

async function pickAnalyzer(): Promise<Analyzer> {
  const p = process.env.UNDERSTAND_ANALYZER;
  if (!p) return rulesAnalyzer;
  const mod = await import(path.resolve(p));
  return mod.default as Analyzer;
}

describe("document understanding evaluation", async () => {
  const cases = loadCases();
  const analyzer = await pickAnalyzer();
  const rows = await runEval(analyzer, cases);

  it("has enough cases covering every category, and PDFs", () => {
    expect(cases.length).toBeGreaterThanOrEqual(14);
    for (const cat of CATEGORIES) expect(cases.some((c) => c.expect.some((x) => x.category === cat)), cat).toBe(true);
    expect(rows.filter((r) => r.source === "pdf").length).toBeGreaterThanOrEqual(4);
    for (const c of cases) for (const x of c.expect) expect(STATUSES).toContain(x.status);
  });

  it("prints the score table", () => {
    const text = report(rows);
    console.log(text);
    const m = misses(rows, cases);
    console.log(`\nmisses (${m.length}):`);
    for (const x of m) console.log(`- ${x.name} [${x.source}] ${x.x.category}/${x.x.status} ${x.x.value ?? x.x.label ?? ""} -> ${x.problem}${x.line ? ` | ${x.line}` : ""}`);
    expect(text.length).toBeGreaterThan(0);
  });

  it("every output matches the schema", () => {
    for (const r of rows) for (const f of r.findings) expect(FindingSchema.safeParse(f).success, `${r.name} ${r.source} ${f.label}`).toBe(true);
  });

  it("no trap value is ever reported as stated", () => {
    for (const r of rows) expect(r.violations.map((v) => `${v.trap.value} <- ${v.finding.label}: ${v.finding.value}`), `${r.name} (${r.source})`).toEqual([]);
  });

  it("every stated finding outside signatures has evidence on its page", () => {
    for (const r of rows)
      for (const f of r.findings.filter((x) => x.status === "stated" && x.category !== "signatures")) {
        expect(f.evidence.length, `${r.name} ${r.source} ${f.label}`).toBeGreaterThan(0);
        for (const e of f.evidence) {
          const page = r.pages.find((p) => p.page === e.page);
          expect(page, `${r.name} ${r.source} page ${e.page}`).toBeTruthy();
          expect(normalize(pageText(page!)), `${r.name} ${r.source} ${f.label}`).toContain(normalize(e.quote));
        }
      }
  });
});
