// Linear-time regression tests for every complex pattern the clause library runs on member input (review of #64, B1).
// Each payload is a pump that made an earlier pattern exponential or quadratic; it must now finish quickly at both
// 200 and 5,000 repeats, through every public entry point.
import { describe, expect, it } from "vitest";
import { formatValue, lookalikeIssue, parsePlaceholders, renderBody, unsafeMarkers, validateBody } from "../../lib/clauses";

const ENTRY: [string, (s: string) => unknown][] = [
  ["unsafeMarkers", unsafeMarkers],
  ["validateBody", validateBody],
  ["formatValue text", (s) => formatValue("text", s)],
  ["formatValue multiline", (s) => formatValue("multiline", s)],
  ["parsePlaceholders", parsePlaceholders],
  ["lookalikeIssue", lookalikeIssue],
  ["renderBody", (s) => { try { renderBody("{{a}} x", [{ path: "a", type: "text" }], { a: s }); } catch { /* refused is fine */ } }],
];
const PUMPS: [string, string, string][] = [
  // [prefix, pump, suffix]
  ["<p ", "x=a/", ""], // B1: "/" in both an unquoted value and the separator (was 2^n)
  ["<p ", "x=a/", ">"],
  ["<p ", "=", ""], // valued-attribute alternative (was quadratic)
  ["<", " ", "x"], // "<\s*\/?\s*" (two adjacent \s*)
  ["<p", " a", ""],
  ["<div ", "a ", ""],
  ["", "[", ""], // markdown link-definition label
  ["- ", "[a", ""],
  ["", "<a", ""],
  ["", "&#", ""],
  ["", "{{", ""],
  ["http", " ", ""],
  ["", "á", ""],
];

describe("clause library patterns run in linear time", () => {
  it.each(PUMPS.map(([p, x, s]) => [JSON.stringify(p + x + "..." + s), p, x, s] as const))("%s", (_n, pre, pump, suf) => {
    for (const [name, f] of ENTRY) {
      for (const [n, budget] of [[200, 50], [5_000, 250]] as const) {
        const text = pre + pump.repeat(n) + suf;
        const t0 = performance.now();
        f(text);
        expect(performance.now() - t0, `${name} x${n}`).toBeLessThan(budget);
      }
    }
  });
  it("the reviewer's exact B1 payload is still refused as markup, and fast", () => {
    const payload = "<p " + "x=a/".repeat(26);
    const t0 = performance.now();
    expect(unsafeMarkers(payload + " hidden>").map((i) => i.code)).toContain("unsafe_html");
    // without a closing ">" (and "p" is not a multi-letter element) the value is not a tag; it is accepted as text
    expect(formatValue("text", payload).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
