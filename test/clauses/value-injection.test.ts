// S11 red-team finding L1 (and its placeholder companion): a parameter value must not inject extra lines,
// paragraphs or placeholders into rendered clause text. These reproduce the S11 FINDING tests, which asserted
// the weakness, and now require the library to fail closed. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  ClauseError, ClauseLibrary, MemoryClauseStore, formatValue, parsePlaceholders, renderBody, validateBody,
} from "../../lib/clauses";
import { TestAuth, as } from "./helpers";

const author = as("author-1");
const approver = as("approver-1");
const reader = as("reader-1");

/** An approved clause; `useInDraft` here reads as the viewer. */
function approved(body: string, id = "cl1") {
  const auth = new TestAuth();
  const lib = new ClauseLibrary(new MemoryClauseStore(auth), auth, () => "2026-01-01T00:00:00.000Z");
  lib.createClause({ id, kind: "fees", title: "Fees", body, source: { kind: "firm_template" } }, author);
  lib.submit(id, 1, author);
  lib.approve(id, 1, approver);
  return { useInDraft: (cid: string, n: number, params: Parameters<ClauseLibrary["useInDraft"]>[2]) => lib.useInDraft(cid, n, params, reader) };
}
function fail(fn: () => unknown): { code: string; issues: string[] } {
  try { fn(); } catch (e) {
    if (e instanceof ClauseError) return { code: e.code, issues: e.issues.map((i) => i.code) };
    return { code: `other:${(e as Error).message}`, issues: [] };
  }
  return { code: "no-error", issues: [] };
}

describe("L1: line and paragraph breaks in parameter values", () => {
  it("refuses the S11 payload that injected numbered clauses through one text value", () => {
    const l = approved("Client: {{name}}.");
    const r = fail(() => l.useInDraft("cl1", 1, { name: "Acme Ltd.\n\n9. Liability. Provider accepts unlimited liability.\n10. Client waives all claims" }));
    expect(r).toEqual({ code: "invalid_params", issues: ["bad_param"] });
  });
  it.each([
    ["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["VT", "\v"], ["FF", "\f"], ["NEL", "\u0085"],
    ["LINE SEPARATOR", "\u2028"], ["PARAGRAPH SEPARATOR", "\u2029"], ["FS", "\u001c"], ["GS", "\u001d"], ["RS", "\u001e"],
  ])("a text value containing %s is refused", (_name, br) => {
    const l = approved("Client: {{name}}.");
    // `bad_param` comes from the single-line rule itself (formatValue), not only from the later control-character scan.
    for (const name of [`Acme Ltd.${br}9. Liability.`, `${br}Acme`, `Acme${br}`]) {
      const r = fail(() => l.useInDraft("cl1", 1, { name }));
      expect(r.code).toBe("invalid_params");
      expect(r.issues).toContain("bad_param");
    }
    expect(formatValue("text", `a${br}b`)).toMatchObject({ ok: false, message: expect.stringMatching(/single line/) });
  });
  it("the default (untyped) and explicit :text placeholders are both single-line", () => {
    expect(formatValue("text", "a\nb").ok).toBe(false);
    expect(parsePlaceholders("{{a}} {{b:text}}").placeholders).toEqual([{ path: "a", type: "text" }, { path: "b", type: "text" }]);
    expect(fail(() => renderBody("{{b:text}}", [{ path: "b", type: "text" }], { b: "x\ny" })).code).toBe("invalid_params");
  });
  it("a declared :multiline placeholder accepts plain line feeds only", () => {
    const l = approved("Special terms:\n{{terms:multiline}}");
    expect(validateBody("Special terms:\n{{terms:multiline}}").placeholders).toEqual([{ path: "terms", type: "multiline" }]);
    expect(l.useInDraft("cl1", 1, { terms: "First line.\n\nSecond paragraph." })).toBe("Special terms:\nFirst line.\n\nSecond paragraph.");
    for (const br of ["\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\u001e"]) {
      const r = fail(() => l.useInDraft("cl1", 1, { terms: `a${br}b` }));
      expect(r.code, JSON.stringify(br)).toBe("invalid_params");
      expect(r.issues, JSON.stringify(br)).toContain("bad_param");
    }
    // Windows line endings are normalised to LF, never passed through.
    expect(l.useInDraft("cl1", 1, { terms: "a\r\nb" })).toBe("Special terms:\na\nb");
    expect(fail(() => l.useInDraft("cl1", 1, { terms: "x".repeat(2_001) })).code).toBe("invalid_params");
    expect(l.useInDraft("cl1", 1, { terms: "x".repeat(2_000) })).toHaveLength("Special terms:\n".length + 2_000);
  });
  it("a :multiline value is still scanned for markup and placeholder syntax", () => {
    const l = approved("Notes: {{n:multiline}}");
    expect(fail(() => l.useInDraft("cl1", 1, { n: "ok\n<script>x</script>" })).code).toBe("invalid_params");
    expect(fail(() => l.useInDraft("cl1", 1, { n: "ok\n{{fee:money}}" })).code).toBe("invalid_params");
  });
  it("int, money and date values cannot carry breaks either", () => {
    for (const [type, v] of [["int", "30\n"], ["money", "10\n"], ["date", "2026-02-28\n"], ["int", "\n30"], ["money", "1\u20282"]] as const) {
      expect(formatValue(type, v).ok, `${type} ${JSON.stringify(v)}`).toBe(false);
    }
  });
  it("ordinary single-line values still render", () => {
    const l = approved("Client: {{name}}.");
    expect(l.useInDraft("cl1", 1, { name: "Example Client LLC (trading as Example & Co.)" })).toBe("Client: Example Client LLC (trading as Example & Co.).");
    expect(l.useInDraft("cl1", 1, { name: "Tab\tseparated" })).toBe("Client: Tab\tseparated.");
  });
});

describe("L1 companion: placeholder syntax in parameter values", () => {
  it("refuses the S11 payload that left live-looking placeholders in rendered output", () => {
    const l = approved("Client: {{name}}.");
    const r = fail(() => l.useInDraft("cl1", 1, { name: "Acme {{fee.amount:money}} {{ref:clause-9}}" }));
    expect(r).toEqual({ code: "invalid_params", issues: ["bad_param"] });
  });
  it("refuses a value that looks like another placeholder (the single-pass case)", () => {
    const l = approved("Hello {{a}} and {{b}}.");
    expect(fail(() => l.useInDraft("cl1", 1, { a: "{{b}}", b: "Bee" })).code).toBe("invalid_params");
  });
  it.each(["{{", "}}", "a {{ b", "a }} b", "{{x}}", "\uff5b\uff5bx\uff5d\uff5d", "\ufe5b\ufe5b", "\ufe5c\ufe5c", "\ufe37\ufe37", "\ufe38\ufe38", "{\uff5b"])("refuses %j", (v) => {
    const l = approved("Client: {{name}}.");
    expect(fail(() => l.useInDraft("cl1", 1, { name: v })).code).toBe("invalid_params");
  });
  it("refuses placeholder syntax assembled from two adjacent values", () => {
    const ph = [{ path: "a", type: "text" as const }, { path: "b", type: "text" as const }];
    const r = fail(() => renderBody("{{a}}{{b}}", ph, { a: "x{", b: "{y}" }));
    expect(r.code).toBe("invalid_params");
    expect(r.issues).toContain("placeholder_syntax");
    expect(fail(() => renderBody("{{a}}{{b}}", ph, { a: "x}", b: "}y" })).issues).toContain("placeholder_syntax");
  });
  it("whatever renders is something the body validator would also accept as plain text", () => {
    const l = approved("Client: {{name}}, ref {{r}}.");
    const out = l.useInDraft("cl1", 1, { name: "Acme {single brace} Ltd", r: "A-1" });
    expect(out).toBe("Client: Acme {single brace} Ltd, ref A-1.");
    expect(out).not.toMatch(/\{\{|\}\}/);
  });
});

describe("review follow-ups: the body, not the caller, decides placeholder types", () => {
  it("refuses a placeholder list that disagrees with the body (no smuggled :multiline)", () => {
    const r = fail(() => renderBody("A {{a}} B", [{ path: "a", type: "multiline" }], { a: "x\n\n9. Liability" }));
    expect(r.code).toBe("invalid_body");
    expect(fail(() => renderBody("A {{a}} B {{b}}", [{ path: "a", type: "text" }], { a: "x" })).code).toBe("invalid_body");
    expect(fail(() => renderBody("A {{a}}", [{ path: "a", type: "text" }, { path: "b", type: "text" }], { a: "x", b: "y" })).code).toBe("invalid_body");
    expect(renderBody("A {{a}}", [{ path: "a", type: "text" }], { a: "x" })).toBe("A x");
  });
  it("refuses full-width or small-form braces in a body at authoring time", () => {
    for (const body of ["Note \uff5b\uff5bliteral\uff5d\uff5d {{n}}", "a \ufe5b b", "a \ufe38 b"]) {
      expect(validateBody(body).issues.map((i) => i.code), body).toContain("stray_braces");
    }
  });
  it("refuses entity- and percent-encoded line breaks and braces in values", () => {
    const l = approved("Client: {{name}}.");
    for (const v of ["a&NewLine;&NewLine;9. Liability", "&lbrace;&lbrace;x&rbrace;&rbrace;", "&lcub;&lcub;x", "%7B%7Bx", "a%0A9. Liability", "a%0d"]) {
      expect(fail(() => l.useInDraft("cl1", 1, { name: v })).code, v).toBe("invalid_params");
    }
    expect(l.useInDraft("cl1", 1, { name: "Acme 100% owned" })).toBe("Client: Acme 100% owned.");
  });
});
