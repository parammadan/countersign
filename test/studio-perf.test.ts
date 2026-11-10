// Hotfix: inputs that were super-linear in the live Studio code now run in bounded time.
import { describe, expect, it } from "vitest";
import { applyProposal } from "@/lib/m23/m23-editor/proposals";
import { cleanSuggestion } from "@/lib/drafts/service";
import type { DraftDocument, EditProposal } from "@/lib/m23/shared/agreement-model";

const ms = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
const docOf = (texts: string[]): DraftDocument => ({
  schema: 1, title: "Perf", parties: [{ role: "Client", name: "Sample Client" }],
  clauses: [...texts.map((text, i) => ({ id: `c${i + 1}`, number: String(i + 1), heading: `H${i + 1}`, text })),
    { id: "signatures", number: String(texts.length + 1), heading: "Signatures", text: "Signed by the parties.", locked: true }],
  origin: { kind: "generated" },
});
const add = (after: string): EditProposal => ({ id: "p1", clauseId: after, op: "add_clause", before: "", after: "Extra term.", rationale: "t", status: "proposed" });

describe("renumbering is linear in the text (sweep finding 1)", () => {
  it("one 20k clause of 'see clause 3 ' renumbers fast and correctly", () => {
    const d = docOf(["Parties.", "B.", "C.", "see clause 3 ".repeat(1538)]);
    let r: ReturnType<typeof applyProposal> | undefined;
    expect(ms(() => { r = applyProposal(d, add("c1")); })).toBeLessThan(400);
    expect(r!.ok).toBe(true);
    if (r!.ok) expect(r!.doc.clauses[4].text.startsWith("see clause 4 see clause 4")).toBe(true);
  });
  it("a 20k clause of 'clause 3, ' (list-ish) is bounded", () => {
    const d = docOf(["Parties.", "B.", "C.", "clause 3, ".repeat(2000)]);
    expect(ms(() => applyProposal(d, add("c1")))).toBeLessThan(600);
  });
  it("50 clauses of 20k references each: one add/delete well under the old 11 s", () => {
    const d = docOf(["Parties.", "B.", "C.", ...Array.from({ length: 47 }, () => "see clause 3 ".repeat(1538))]);
    expect(ms(() => applyProposal(d, add("c1")))).toBeLessThan(4000);
  });
  it("the bounded window still fails closed: an introducer cut off at the window start is not trusted", () => {
    // "under" is 300 chars before "clause 3": outside the window, so the reference is checked as unknown
    const d = docOf(["Parties.", "B.", "C.", `Payment under${"x".repeat(300)} clause 3 applies.`]);
    const r = applyProposal(d, add("c1"));
    expect(r.ok === false && r.status).toBe("conflict");
  });
});

describe("AI suggestion name check is linear (sweep finding 2)", () => {
  it("the 4k cubic payload now takes milliseconds", () => {
    const description = "A".repeat(2000) + "1" + " Bob X".repeat(333);
    expect(ms(() => cleanSuggestion({ parties: [{ role: "Client", name: "Bob" }] }, description))).toBeLessThan(200);
  });
  it("a chain of lowercase matches is bounded", () => {
    const description = "bob-".repeat(1000);
    expect(ms(() => cleanSuggestion({ parties: [{ role: "Client", name: "Bob" }] }, description))).toBeLessThan(200);
  });
});
