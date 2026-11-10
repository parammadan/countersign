import { describe, it, expect } from "vitest";
import {
  applyProposal, createEditor, acceptProposal, rejectProposal, undoProposal, openProposals,
  diffWords, originalText, proposedText,
  emptyHistory, commitVersion, rollbackTo, getVersion,
  newApproval, submitForApproval, approve, requestChanges, publish, recordEdit, availableActions, gateContext,
  type DraftDocument, type EditProposal,
} from "@/lib/m23/m23-editor";

const doc = (): DraftDocument => ({
  schema: 1, title: "Example Services Agreement", parties: [{ role: "Client", name: "Sample Client" }],
  clauses: [
    { id: "c1", text: "The Client shall pay the fee within 30 days of invoice." },
    { id: "c2", text: "Either party may terminate on 30 days notice." },
    { id: "c3", text: "Governing law is fixed.", locked: true },
  ],
  origin: { kind: "generated" },
});
const prop = (o: Partial<EditProposal> & { id: string }): EditProposal => ({
  clauseId: "c1", op: "replace", before: "30 days of invoice", after: "14 days of invoice", rationale: "faster", status: "proposed", ...o,
});

describe("applyProposal", () => {
  it("replace, insert_after, delete, add_clause", () => {
    const d = doc();
    const r = applyProposal(d, prop({ id: "p1" }));
    expect(r.ok && r.doc.clauses[0].text).toBe("The Client shall pay the fee within 14 days of invoice.");
    const i = applyProposal(d, prop({ id: "p2", op: "insert_after", before: "the fee", after: " in full" }));
    expect(i.ok && i.doc.clauses[0].text).toContain("the fee in full within");
    const x = applyProposal(d, prop({ id: "p3", op: "delete", before: " of invoice", after: "" }));
    expect(x.ok && x.doc.clauses[0].text).toBe("The Client shall pay the fee within 30 days.");
    const a = applyProposal(d, prop({ id: "p4", op: "add_clause", before: "", after: "Confidentiality applies." }));
    expect(a.ok && a.doc.clauses.map((c) => c.id)).toEqual(["c1", "new:p4", "c2", "c3"]);
    const end = applyProposal(d, prop({ id: "p5", op: "add_clause", clauseId: "", before: "", after: "Last." }));
    expect(end.ok && end.doc.clauses.at(-1)?.text).toBe("Last.");
  });
  it("delete of the whole clause text removes the clause", () => {
    const d = doc();
    const r = applyProposal(d, prop({ id: "p", clauseId: "c2", op: "delete", before: d.clauses[1].text, after: "" }));
    expect(r.ok && r.doc.clauses.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
  it("conflicts when before is missing, ambiguous, or clause unknown", () => {
    const d = doc();
    expect(applyProposal(d, prop({ id: "a", before: "nope" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "b2", op: "insert_after", before: "e", after: "!" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "b3", op: "delete", before: "e", after: "" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "b4", op: "add_clause", before: "", after: "   " }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "c", before: "e" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "d", before: "" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "e", clauseId: "zz" }))).toMatchObject({ ok: false, status: "conflict" });
    expect(applyProposal(d, prop({ id: "f", op: "add_clause", before: "x", after: "y" }))).toMatchObject({ ok: false });
  });
  it("a unique before in another clause is not a conflict", () => {
    expect(applyProposal(doc(), prop({ id: "b", clauseId: "c2", before: "30", after: "60" }))).toMatchObject({ ok: true });
  });
  it("delete with non-empty after is a conflict", () => {
    expect(applyProposal(doc(), prop({ id: "dx", op: "delete", before: " of invoice", after: "oops" }))).toMatchObject({ ok: false, status: "conflict" });
  });
  it("undo keeps the errors of other conflicting proposals", () => {
    let s = createEditor(doc(), [
      prop({ id: "p1", before: "absent" }),
      prop({ id: "p2", clauseId: "c2", before: "30 days", after: "60 days" }),
    ]);
    s = acceptProposal(s, "p1");
    expect(s.errors.p1).toBeTruthy();
    s = acceptProposal(s, "p2");
    s = undoProposal(s, "p2");
    expect(s.proposals.find((p) => p.id === "p1")?.status).toBe("conflict");
    expect(s.errors.p1).toBeTruthy();
  });
  it("undo keeps the error of a blocked proposal", () => {
    let s = createEditor(doc(), [
      prop({ id: "pb", clauseId: "c3", before: "fixed", after: "flexible" }),
      prop({ id: "p2", clauseId: "c2", before: "30 days", after: "60 days" }),
    ]);
    s = acceptProposal(s, "pb");
    expect(s.proposals.find((p) => p.id === "pb")?.status).toBe("blocked");
    s = acceptProposal(s, "p2");
    s = undoProposal(s, "p2");
    expect(s.errors.pb).toBeTruthy();
  });
  it("blocks edits to locked clauses and never mutates the input", () => {
    const d = doc();
    const snap = structuredClone(d);
    expect(applyProposal(d, prop({ id: "l", clauseId: "c3", before: "fixed", after: "flexible" }))).toMatchObject({ ok: false, status: "blocked" });
    applyProposal(d, prop({ id: "p1" }));
    expect(d).toEqual(snap);
  });
});

describe("editor accept/reject/undo", () => {
  it("accept then undo round-trips to the base document", () => {
    const base = doc();
    let s = createEditor(base, [prop({ id: "p1" }), prop({ id: "p2", clauseId: "c2", before: "30 days notice", after: "60 days notice" })]);
    s = acceptProposal(s, "p1");
    s = acceptProposal(s, "p2");
    expect(s.doc.clauses[0].text).toContain("14 days");
    expect(s.doc.clauses[1].text).toContain("60 days");
    s = undoProposal(s, "p2");
    s = undoProposal(s, "p1");
    expect(s.doc.clauses).toEqual(base.clauses);
    expect(s.proposals.every((p) => p.status === "proposed")).toBe(true);
  });
  it("undoing an earlier proposal turns a dependent later one into a conflict", () => {
    let s = createEditor(doc(), [
      prop({ id: "p1", before: "30 days", after: "14 days" }),
      prop({ id: "p2", before: "14 days of", after: "10 days of" }),
    ]);
    s = acceptProposal(s, "p1");
    s = acceptProposal(s, "p2");
    s = undoProposal(s, "p1");
    expect(s.proposals.find((p) => p.id === "p2")?.status).toBe("conflict");
    expect(s.errors.p2).toBeTruthy();
    expect(s.doc.clauses[0].text).toBe(doc().clauses[0].text);
    expect(openProposals(s).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
  it("accepting a conflicting proposal records conflict and leaves doc unchanged", () => {
    let s = createEditor(doc(), [prop({ id: "p1", before: "absent" })]);
    s = acceptProposal(s, "p1");
    expect(s.proposals[0].status).toBe("conflict");
    expect(s.doc).toEqual(doc());
  });
  it("reject, undo reject, and invalid transitions throw", () => {
    let s = createEditor(doc(), [prop({ id: "p1" }), prop({ id: "pb", status: "blocked" })]);
    s = rejectProposal(s, "p1");
    expect(s.proposals[0].status).toBe("rejected");
    expect(() => acceptProposal(s, "p1")).toThrow();
    s = undoProposal(s, "p1");
    expect(s.proposals[0].status).toBe("proposed");
    expect(() => acceptProposal(s, "pb")).toThrow();
    expect(() => undoProposal(s, "p1")).toThrow();
    expect(() => undoProposal(s, "pb")).toThrow();
    s = rejectProposal(s, "pb");
    expect(s.proposals.find((q) => q.id === "pb")?.status).toBe("rejected");
    expect(openProposals(s).map((q) => q.id)).toEqual(["p1"]);
    expect(() => acceptProposal(s, "zz")).toThrow();
  });
  it("accepting on a locked clause marks blocked with an error", () => {
    let s = createEditor(doc(), [prop({ id: "pl", clauseId: "c3", before: "fixed", after: "flexible" })]);
    s = acceptProposal(s, "pl");
    expect(s.proposals[0].status).toBe("blocked");
    expect(s.errors.pl).toContain("locked");
    expect(s.doc).toEqual(doc());
  });
  it("rehydrates accepted proposals into the doc and rejects duplicate ids", () => {
    const s = createEditor(doc(), [prop({ id: "p1", status: "accepted" })]);
    expect(s.doc.clauses[0].text).toContain("14 days");
    expect(s.accepted).toEqual(["p1"]);
    expect(undoProposal(s, "p1").doc.clauses).toEqual(doc().clauses);
    expect(() => createEditor(doc(), [prop({ id: "x" }), prop({ id: "x" })])).toThrow();
  });
  it("does not mutate the proposals passed in", () => {
    const ps = [prop({ id: "p1" })];
    acceptProposal(createEditor(doc(), ps), "p1");
    expect(ps[0].status).toBe("proposed");
  });
});

describe("diffWords", () => {
  it("reconstructs both sides exactly", () => {
    const cases: [string, string][] = [
      ["pay within 30 days", "pay within 14 days"], ["", "new text"], ["old text", ""], ["same  text\n", "same  text\n"],
      ["a b c d", "a x c y d z"],
    ];
    for (const [a, b] of cases) {
      const d = diffWords(a, b);
      expect(originalText(d)).toBe(a);
      expect(proposedText(d)).toBe(b);
    }
  });
  it("falls back to a coarse but exact diff for huge inputs", () => {
    const a = "start " + "alpha ".repeat(2500) + "end";
    const b = "start " + "beta ".repeat(2500) + "end";
    const d = diffWords(a, b);
    expect(originalText(d)).toBe(a);
    expect(proposedText(d)).toBe(b);
    expect(d.length).toBeLessThanOrEqual(4);
  });
  it("marks only the changed words", () => {
    const d = diffWords("pay within 30 days", "pay within 14 days");
    expect(d.filter((s) => s.op === "delete").map((s) => s.text)).toEqual(["30"]);
    expect(d.filter((s) => s.op === "insert").map((s) => s.text)).toEqual(["14"]);
    expect(diffWords("same", "same")).toEqual([{ op: "equal", text: "same" }]);
  });
});

describe("version history", () => {
  const meta = { author: "ed@example.test", at: "2026-11-09T05:00:00Z" };
  it("snapshots are immutable copies", () => {
    const d = doc();
    const h = commitVersion(emptyHistory, d, meta);
    d.clauses[0].text = "changed after";
    expect(h.versions[0].doc.clauses[0].text).toContain("30 days");
    expect(() => { (h.versions[0].doc.clauses[0] as { text: string }).text = "x"; }).toThrow();
    expect(() => { (h.versions as unknown as unknown[]).push(1); }).toThrow();
  });
  it("rollback creates a new version and never mutates earlier ones", () => {
    let h = commitVersion(emptyHistory, doc(), meta, "edit");
    const edited = applyProposal(doc(), prop({ id: "p1" }));
    if (!edited.ok) throw new Error("x");
    h = commitVersion(h, edited.doc, meta);
    const before = JSON.stringify(h.versions);
    const h2 = rollbackTo(h, "v1", meta);
    expect(JSON.stringify(h.versions)).toBe(before);
    expect(h2.versions).toHaveLength(3);
    expect(JSON.stringify(h2.versions.slice(0, 2))).toBe(before);
    expect(h2.versions[2]).toMatchObject({ id: "v3", kind: "rollback", restoredFrom: "v1" });
    expect(h2.versions[2].doc.clauses).toEqual(getVersion(h2, "v1")!.doc.clauses);
    expect(h2.versions[2].doc.origin).toEqual({ kind: "edit", versionId: "v1" });
    expect(() => rollbackTo(h, "v9", meta)).toThrow();
  });
});

describe("approval state machine", () => {
  const ed = { userId: "ed", role: "editor" } as const;
  const ap = { userId: "boss", role: "approver" } as const;
  const viewer = { userId: "v", role: "viewer" } as const;
  const on = { requireDistinctApprover: true };
  const off = { requireDistinctApprover: false };
  // The party check is mandatory and runs on the history: these approval-logic tests pass a real history of an
  // unedited document whose latest version is `v`.
  const H = (v = "v1") => {
    let h = emptyHistory;
    for (let i = 0; i < Number(v.slice(1)); i++) h = commitVersion(h, doc(), { author: "gen", at: `t${i}` });
    return h;
  };
  const ctx = { openProposals: 0, currentVersionId: "v1", history: H() };
  const ok = (r: ReturnType<typeof submitForApproval>) => { if (!r.ok) throw new Error(r.message); return r.state; };
  const code = (r: ReturnType<typeof submitForApproval>) => (r.ok ? "ok" : r.code);

  it("happy path draft → pending → approved → published", () => {
    let s = newApproval("v1", "ed");
    s = ok(submitForApproval(s, ed));
    expect(s.status).toBe("pending_approval");
    s = ok(approve(s, ap, on, ctx));
    expect(s).toMatchObject({ status: "approved", approvedBy: "boss" });
    s = ok(publish(s, ap, ctx));
    expect(s.status).toBe("published");
    expect(s.log.map((l) => l.action)).toEqual(["submit", "approve", "publish"]);
  });
  it("only approvers approve; viewers cannot submit or publish", () => {
    const pending = ok(submitForApproval(newApproval("v1", "ed"), ed));
    expect(code(approve(pending, ed, off, ctx))).toBe("forbidden_role");
    expect(code(approve(pending, viewer, off, ctx))).toBe("forbidden_role");
    expect(code(submitForApproval(newApproval("v1", "ed"), viewer))).toBe("forbidden_role");
    const approved = ok(approve(pending, ap, off, ctx));
    expect(code(publish(approved, viewer, ctx))).toBe("forbidden_role");
    expect(code(requestChanges(pending, ed))).toBe("forbidden_role");
  });
  it("distinct approver setting", () => {
    const self = { userId: "ed", role: "approver" } as const;
    const pending = ok(submitForApproval(newApproval("v1", "ed"), self));
    expect(code(approve(pending, self, on, ctx))).toBe("same_person");
    expect(code(approve(pending, self, off, ctx))).toBe("same_person"); // the setting can no longer allow self-approval
  });
  it("invalid transitions are refused", () => {
    const d = newApproval("v1", "ed");
    expect(code(approve(d, ap, off, ctx))).toBe("invalid_transition");
    expect(code(publish(d, ap, ctx))).toBe("invalid_transition");
    expect(code(requestChanges(d, ap))).toBe("invalid_transition");
    const pending = ok(submitForApproval(d, ed));
    expect(code(submitForApproval(pending, ed))).toBe("invalid_transition");
    expect(code(publish(pending, ap, ctx))).toBe("invalid_transition");
  });
  it("approve refuses when the current version moved on", () => {
    const pending = ok(submitForApproval(newApproval("v1", "ed"), ed));
    expect(code(approve(pending, ap, off, { currentVersionId: "v2", history: H("v2") }))).toBe("stale_version");
    expect(code(approve(pending, ap, off, { currentVersionId: "v1", history: H() }))).toBe("ok");
    const edited = recordEdit(ok(approve(pending, ap, off, ctx)), ed, "v2");
    expect(edited.ok && "approvedBy" in edited.state).toBe(false);
  });
  it("publish blocked by open proposals and stale version", () => {
    const approved = ok(approve(ok(submitForApproval(newApproval("v1", "ed"), ed)), ap, on, ctx));
    expect(code(publish(approved, ap, { openProposals: 2, currentVersionId: "v1", history: H() }))).toBe("open_proposals");
    expect(code(publish(approved, ap, { openProposals: 0, currentVersionId: "v2", history: H("v2") }))).toBe("stale_version");
  });
  it("request changes returns to draft; an edit clears approval", () => {
    const pending = ok(submitForApproval(newApproval("v1", "ed"), ed));
    expect(ok(requestChanges(pending, ap)).status).toBe("draft");
    const approved = ok(approve(pending, ap, on, ctx));
    const edited = recordEdit(approved, ed, "v2");
    expect(edited.ok && edited.state).toMatchObject({ status: "draft", versionId: "v2", lastEditor: "ed" });
    expect(code(recordEdit(approved, viewer, "v2"))).toBe("forbidden_role");
  });
  it("approved refuses submit, approve and requestChanges", () => {
    const approved = ok(approve(ok(submitForApproval(newApproval("v1", "ed"), ed)), ap, off, ctx));
    expect(code(submitForApproval(approved, ed))).toBe("invalid_transition");
    expect(code(approve(approved, ap, off, ctx))).toBe("invalid_transition");
    expect(code(requestChanges(approved, ap))).toBe("invalid_transition");
  });
  it("recordEdit from pending_approval returns to draft", () => {
    const pending = ok(submitForApproval(newApproval("v1", "ed"), ed));
    const r = recordEdit(pending, ed, "v2");
    expect(r.ok && r.state).toMatchObject({ status: "draft", versionId: "v2" });
  });
  it("published is final", () => {
    const pub = ok(publish(ok(approve(ok(submitForApproval(newApproval("v1", "ed"), ed)), ap, on, ctx)), ap, ctx));
    for (const r of [recordEdit(pub, ed, "v2"), submitForApproval(pub, ed), approve(pub, ap, off, ctx), requestChanges(pub, ap), publish(pub, ap, ctx)])
      expect(code(r)).toBe("published_is_final");
  });
  it("availableActions mirrors the refusals", () => {
    const pending = ok(submitForApproval(newApproval("v1", "ed"), ed));
    const a = availableActions(pending, ed, on, ctx);
    expect(a.approve.enabled).toBe(false);
    expect(availableActions(pending, ap, on, ctx).approve.enabled).toBe(true);
  });
});

describe("rehydration and gate context", () => {
  it("gives rehydrated conflict and blocked proposals an error message", () => {
    const s = createEditor(doc(), [
      prop({ id: "x", before: "absent", status: "conflict" }),
      prop({ id: "y", clauseId: "c3", before: "fixed", after: "flexible", status: "blocked" }),
    ]);
    expect(s.proposals.map((p) => p.status)).toEqual(["conflict", "blocked"]);
    expect(s.errors.x).toMatch(/not found/);
    expect(s.errors.y).toMatch(/locked/);
  });

  it("derives gate values from editor and history; publish refuses while proposals are open", () => {
    const editor = createEditor(doc(), [prop({ id: "p1" })]);
    const h = commitVersion(emptyHistory, editor.doc, { author: "ed", at: "2026-01-01T00:00:00Z" });
    expect(gateContext(editor, h)).toMatchObject({ openProposals: 1, currentVersionId: "v1", history: h });
    expect(() => gateContext(editor, emptyHistory)).toThrow();
    const approved = { ...newApproval("v1", "ed"), status: "approved" as const };
    const pr = publish(approved, { userId: "ed", role: "editor" }, gateContext(editor, h));
    expect(pr.ok === false && pr.code).toBe("open_proposals");
    const done = acceptProposal(editor, "p1");
    const h2 = commitVersion(h, done.doc, { author: "ed", at: "2026-01-01T00:01:00Z" });
    expect(gateContext(done, h2)).toMatchObject({ openProposals: 0, currentVersionId: "v2", history: h2 });
  });

  it("rollback then recordEdit then approve works on the new version", () => {
    const ed = { userId: "ed", role: "editor" as const };
    const ap = { userId: "ap", role: "approver" as const };
    let h = commitVersion(emptyHistory, doc(), { author: "ed", at: "t1" });
    h = commitVersion(h, { ...doc(), title: "Changed" }, { author: "ed", at: "t2" });
    h = rollbackTo(h, "v1", { author: "ed", at: "t3" });
    const e = createEditor(h.versions[2].doc, []);
    let s = newApproval("v2", "ed");
    const r1 = recordEdit(s, ed, "v3"); if (!r1.ok) throw new Error("x"); s = r1.state;
    const r2 = submitForApproval(s, ed); if (!r2.ok) throw new Error("x"); s = r2.state;
    const r3 = approve(s, ap, { requireDistinctApprover: true }, gateContext(e, h));
    expect(r3.ok).toBe(true);
    const stale = approve(s, ap, { requireDistinctApprover: true }, { currentVersionId: "v2", history: h });
    expect(stale.ok === false && stale.code).toBe("stale_version");
  });
});
