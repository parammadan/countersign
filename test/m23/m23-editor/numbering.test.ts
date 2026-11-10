// Clause numbering after add_clause / delete: S1 numbers clauses "1".."N" in order and resolves cross-references to
// "clause N"; an edit must keep that sequence unique so a renderer never shows two clauses with the same number.
import { describe, it, expect } from "vitest";
import { applyProposal, createEditor, acceptProposal, undoProposal, type DraftDocument, type EditProposal, type Clause } from "@/lib/m23/m23-editor";

const numbered = (): DraftDocument => ({
  schema: 1, title: "Example Services Agreement", parties: [{ role: "Client", name: "Sample Client" }],
  clauses: [
    { id: "parties", number: "1", heading: "Parties", text: "This agreement is between the parties." },
    { id: "services", number: "2", heading: "Services", text: "The services are described in clause 4. Fees are in Clause 3." },
    { id: "fees", number: "3", heading: "Fees", text: "The Client shall pay the fee within 30 days." },
    { id: "obligations", number: "4", heading: "Obligations", text: "Each party performs its obligations." },
    { id: "law", number: "5", heading: "Law", text: "Governing law is fixed; clause 4 survives termination.", locked: true },
  ],
  origin: { kind: "generated" },
});
let n = 0;
const add = (after: string, text = "Confidentiality applies."): EditProposal =>
  ({ id: `a${++n}`, clauseId: after, op: "add_clause", before: "", after: text, rationale: "t", status: "proposed" });
const del = (doc: DraftDocument, id: string): EditProposal =>
  ({ id: `d${++n}`, clauseId: id, op: "delete", before: doc.clauses.find((c) => c.id === id)!.text, after: "", rationale: "t", status: "proposed" });
const nums = (d: DraftDocument) => d.clauses.map((c) => c.number);
/** Numbered clauses are exactly "1".."K" in order, with no repeats. */
function expectSequential(cs: Clause[]) {
  const ns = cs.map((c) => c.number).filter((x): x is string => x !== undefined);
  expect(new Set(ns).size).toBe(ns.length);
  expect(ns).toEqual(ns.map((_, i) => String(i + 1)));
}
const doc = (r: ReturnType<typeof applyProposal>) => { if (!r.ok) throw new Error(r.reason); return r.doc; };

describe("clause numbering after structural edits", () => {
  it("adding in the middle renumbers the following clauses and their references", () => {
    const d = doc(applyProposal(numbered(), add("services")));
    expect(d.clauses.map((c) => c.id)).toEqual(["parties", "services", "new:" + `a${n}`, "fees", "obligations", "law"]);
    expect(nums(d)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expectSequential(d.clauses);
    expect(d.clauses[1].text).toBe("The services are described in clause 5. Fees are in Clause 4.");
    expect(d.clauses[5]).toMatchObject({ number: "6", locked: true, text: "Governing law is fixed; clause 5 survives termination." });
  });
  it("adding at the end gives the next number and changes no reference", () => {
    const d = doc(applyProposal(numbered(), add("")));
    expect(nums(d)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(d.clauses.slice(0, 5)).toEqual(numbered().clauses);
  });
  it("deleting a clause closes the gap and rewrites references", () => {
    const d = doc(applyProposal(numbered(), del(numbered(), "parties")));
    expect(d.clauses.map((c) => c.id)).toEqual(["services", "fees", "obligations", "law"]);
    expect(nums(d)).toEqual(["1", "2", "3", "4"]);
    expect(d.clauses[0].text).toBe("The services are described in clause 3. Fees are in Clause 2.");
    expect(d.clauses[3].text).toBe("Governing law is fixed; clause 3 survives termination.");
  });
  it("deleting a clause that other text refers to is a conflict", () => {
    const r = applyProposal(numbered(), del(numbered(), "obligations"));
    expect(r.ok === false && r.status).toBe("conflict");
    expect(r.ok === false && r.reason).toMatch(/refers to clause 4/);
    expect(applyProposal(numbered(), del(numbered(), "fees")).ok).toBe(false);
  });
  it("undo of an add or a delete restores the original numbers and text", () => {
    const base = numbered();
    const pa = add("parties"), pd = del(base, "parties");
    let e = createEditor(base, [pa, pd]);
    e = acceptProposal(e, pa.id);
    e = acceptProposal(e, pd.id);
    expect(nums(e.doc)).toEqual(["1", "2", "3", "4", "5"]);
    expectSequential(e.doc.clauses);
    const undoneAdd = undoProposal(e, pa.id);
    expect(undoneAdd.proposals.find((p) => p.id === pd.id)?.status).toBe("accepted");
    expect(nums(undoneAdd.doc)).toEqual(["1", "2", "3", "4"]);
    expectSequential(undoneAdd.doc.clauses);
    const undoneBoth = undoProposal(undoneAdd, pd.id);
    expect(undoneBoth.doc.clauses).toEqual(base.clauses);
  });
  it("several adds and deletes in any order keep one sequence", () => {
    const base = numbered();
    const ps = [add("law"), add("parties"), add("fees"), del(base, "parties")];
    let e = createEditor(base, ps);
    for (const p of ps) { e = acceptProposal(e, p.id); expectSequential(e.doc.clauses); }
    expect(e.proposals.every((p) => p.status === "accepted")).toBe(true);
    expect(e.doc.clauses).toHaveLength(base.clauses.length + 2);
    // A later proposal quoting base text (with base clause numbers) still applies after references were rewritten.
    const late = del(base, "services");
    e = createEditor(base, [...e.proposals, late]);
    e = acceptProposal(e, late.id);
    expect(e.proposals.find((p) => p.id === late.id)?.status).toBe("accepted");
    expectSequential(e.doc.clauses);
  });
  it("a document with no numbers stays unnumbered", () => {
    const plain: DraftDocument = { ...numbered(), clauses: numbered().clauses.map((c) => { const { number, ...rest } = c; void number; return rest; }) };
    const d = doc(applyProposal(plain, add("services")));
    expect(nums(d).every((x) => x === undefined)).toBe(true);
    expect(d.clauses[1].text).toBe(plain.clauses[1].text);
    expect(nums(doc(applyProposal(plain, del(plain, "fees")))).every((x) => x === undefined)).toBe(true); // no numbers, so no reference check either
  });
  it("an unnumbered clause (e.g. a signature block) stays unnumbered and is skipped", () => {
    const withSig: DraftDocument = { ...numbered(), clauses: [...numbered().clauses, { id: "sig", text: "Signed by the parties.", locked: true }] };
    const d = doc(applyProposal(withSig, add("services")));
    expect(nums(d)).toEqual(["1", "2", "3", "4", "5", "6", undefined]);
    expect(nums(doc(applyProposal(withSig, add(""))))).toEqual(["1", "2", "3", "4", "5", undefined, "6"]);
  });
  it("a non-sequential numbering scheme refuses an add but allows a delete", () => {
    const custom: DraftDocument = { ...numbered(), clauses: numbered().clauses.map((c, i) => ({ ...c, number: `A${i + 1}` })) };
    const r = applyProposal(custom, add("services"));
    expect(r.ok === false && r.status).toBe("conflict");
    expect(nums(doc(applyProposal(custom, del(custom, "fees"))))).toEqual(["A1", "A2", "A4", "A5"]);
  });
  it("a reference in a proposal means the base numbering, whatever was accepted before it", () => {
    const base = numbered();
    const pa = add("parties");
    const ref: EditProposal = { id: `r${++n}`, clauseId: "fees", op: "insert_after", before: "30 days", after: " Subject to clause 4.", rationale: "t", status: "proposed" };
    let e = createEditor(base, [pa, ref]);
    e = acceptProposal(e, pa.id);
    e = acceptProposal(e, ref.id);
    const fees = () => e.doc.clauses.find((c) => c.id === "fees")!;
    const obligations = () => e.doc.clauses.find((c) => c.id === "obligations")!;
    expect(fees().text).toContain(`Subject to clause ${obligations().number}.`);
    expect(obligations().number).toBe("5");
    // Undo the add: the reference follows obligations back to 4 instead of pointing at a different clause.
    e = undoProposal(e, pa.id);
    expect(fees().text).toContain("Subject to clause 4.");
    expect(obligations().number).toBe("4");
    // Rehydration from saved statuses gives the same document.
    const again = createEditor(base, [{ ...pa, status: "accepted" }, { ...ref, status: "accepted" }]);
    expect(again.doc.clauses.find((c) => c.id === "fees")!.text).toContain("Subject to clause 5.");
    expectSequential(again.doc.clauses);
  });
  it("a new clause's own references are in base numbering too", () => {
    const d = doc(applyProposal(numbered(), add("parties", "Subject to clause 3.")));
    expect(d.clauses[1]).toMatchObject({ number: "2", text: "Subject to clause 4." });
    expect(d.clauses[3].id).toBe("fees");
  });
  it("plural, upper-case, sub-clause and range references are rewritten", () => {
    const base = numbered();
    const withRefs: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "See clauses 3 and 4, CLAUSE 4.2 and Clauses 3 to 4." } : c)) };
    const d = doc(applyProposal(withRefs, add("parties")));
    expect(d.clauses.find((c) => c.id === "fees")!.text).toBe("See clauses 4 and 5, CLAUSE 5.2 and Clauses 4 to 5.");
  });
  it("lists with an Oxford comma, &, and/or are rewritten item by item", () => {
    const base = numbered();
    const lists: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "See clauses 2, 3, and 4; clauses 2 & 3; clauses 2 and/or 3." } : c)) };
    const d = doc(applyProposal(lists, add("parties")));
    expect(d.clauses.find((c) => c.id === "fees")!.text).toBe("See clauses 3, 4, and 5; clauses 3 & 4; clauses 3 and/or 4.");
  });
  it("after a singular 'clause', only the first number is a reference", () => {
    const base = numbered();
    const prose: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "Under clause 3, 2 copies are due." } : c)) };
    // stricter since the integrated review: "2" in the same sentence would also shift, so this now conflicts
    const r = applyProposal(prose, add("parties"));
    expect(r.ok === false && r.status).toBe("conflict");
    expect(doc(applyProposal(prose, add(""))).clauses.find((c) => c.id === "fees")!.text).toBe("Under clause 3, 2 copies are due.");
  });
  it("a singular 'clause' list (or, and, a dash) is rewritten in full and checked for deletion", () => {
    const base = numbered();
    const lists: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "See clause 3 or 4, clause 3 and 4, clause 3-4." } : c)) };
    const d = doc(applyProposal(lists, add("parties")));
    expect(d.clauses.find((c) => c.id === "fees")!.text).toBe("See clause 4 or 5, clause 4 and 5, clause 4-5.");
    const del4: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "parties" ? { ...c, text: "See clause 3 or 4." } : c.id === "law" ? { ...c, text: "Law." } : c.id === "services" ? { ...c, text: "Services." } : c)) };
    const r = applyProposal(del4, del(del4, "obligations"));
    expect(r.ok === false && r.reason).toMatch(/clause 4, which is being deleted/);
  });
  it("a reference to a clause that did not exist is refused once that number would exist", () => {
    const base = numbered();
    const dangling: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "As in clause 6." } : c)) };
    const r = applyProposal(dangling, add(""));
    expect(r.ok === false && r.reason).toMatch(/clause 6, which did not exist/);
    const far: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "fees" ? { ...c, text: "As in clause 99." } : c)) };
    expect(doc(applyProposal(far, add(""))).clauses.find((c) => c.id === "fees")!.text).toBe("As in clause 99.");
  });
  it("a range that would change meaning, or a plural reference to a deleted clause, is a conflict", () => {
    const base = numbered();
    const ranged: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "parties" ? { ...c, text: "Clauses 2 to 4 apply." } : c)) };
    const inside = applyProposal(ranged, add("services"));
    expect(inside.ok === false && inside.reason).toMatch(/range/);
    expect(applyProposal(ranged, add("")).ok).toBe(true);
    const plural: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "parties" ? { ...c, text: "See clauses 3 and 4." } : c)) };
    const r = applyProposal(plural, del(plural, "fees"));
    expect(r.ok === false && r.reason).toMatch(/refers to clause 3, which is being deleted/);
  });
  it("a reference held in a locked clause says so", () => {
    const r = applyProposal(numbered(), del(numbered(), "obligations"));
    expect(r.ok === false && r.reason).toMatch(/clause 2 refers to clause 4/);
    const lockedOnly: DraftDocument = { ...numbered(), clauses: numbered().clauses.map((c) => (c.id === "services" ? { ...c, text: "Services." } : c)) };
    const r2 = applyProposal(lockedOnly, del(lockedOnly, "obligations"));
    expect(r2.ok === false && r2.reason).toMatch(/locked clause 5 refers to clause 4.*regenerate the draft or reject this edit/);
  });
  it("adding at the end goes before a trailing locked signature block", () => {
    const base = numbered();
    const s1: DraftDocument = { ...base, clauses: [...base.clauses, { id: "signatures", number: "6", heading: "Signatures", text: "Signed by the parties.", locked: true }] };
    const d = doc(applyProposal(s1, add("")));
    expect(d.clauses.map((c) => c.id).slice(-2)).toEqual([`new:a${n}`, "signatures"]);
    expect(nums(d)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(d.clauses.at(-1)).toMatchObject({ id: "signatures", number: "7" });
  });
  it("undo of a delete on its own, and delete of the last clause", () => {
    const base = numbered();
    const pd = del(base, "parties");
    let e = acceptProposal(createEditor(base, [pd]), pd.id);
    expect(nums(e.doc)).toEqual(["1", "2", "3", "4"]);
    e = undoProposal(e, pd.id);
    expect(e.doc.clauses).toEqual(base.clauses);
    const unlockedLast: DraftDocument = { ...base, clauses: base.clauses.map((c) => (c.id === "law" ? { ...c, locked: false, text: "Governing law." } : c)) };
    expect(nums(doc(applyProposal(unlockedLast, del(unlockedLast, "law"))))).toEqual(["1", "2", "3", "4"]);
  });
  it("replace and insert_after never change numbers", () => {
    const d = doc(applyProposal(numbered(), { id: "r", clauseId: "fees", op: "insert_after", before: "30 days", after: " of invoice", rationale: "t", status: "proposed" }));
    expect(nums(d)).toEqual(["1", "2", "3", "4", "5"]);
  });
});
