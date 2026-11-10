// Party-drift gate: approve/publish refuse unless the drift check ran on the version and passed. Synthetic data only.
import { describe, it, expect } from "vitest";
import {
  createEditor, acceptProposal, emptyHistory, commitVersion, newApproval, recordEdit, submitForApproval, approve, publish,
  availableActions, gateContext, checkCommittedParties, partyDriftBetween, MAX_CHECKED_CLAUSE,
  type DraftDocument, type EditProposal, type ApprovalState, type TransitionResult, type VersionHistory,
} from "@/lib/m23/m23-editor";

const base = (): DraftDocument => ({
  schema: 1, title: "Example Services Agreement",
  parties: [{ role: "Client", name: "Jordan Example" }, { role: "Provider", name: "Acme Widgets Ltd" }],
  clauses: [
    { id: "c1", heading: "Parties", text: "This agreement is between Acme Widgets Ltd (the \"Provider\") and Jordan Example (the \"Client\")." },
    { id: "c2", heading: "Fees", text: "The Client shall pay the Fees within 30 days of invoice." },
    { id: "c3", heading: "Services", text: "Acme Widgets Ltd will deliver the Services described in Schedule A." },
    { id: "c4", heading: "Law", text: "This Agreement is governed by the laws of England and Wales." },
    // A signable document has a locked clause; approve and publish also run the renderer's validateDraft.
    { id: "signatures", heading: "Signatures", text: "Signed by the parties.", locked: true },
  ],
  origin: { kind: "generated" },
});
let n = 0;
const edit = (clauseId: string, before: string, after: string, op: EditProposal["op"] = "replace"): EditProposal =>
  ({ id: `p${++n}`, clauseId, op, before, after, rationale: "test", status: "proposed" });

const ed = { userId: "ed", role: "editor" } as const;
const ap = { userId: "boss", role: "approver" } as const;
const set = { requireDistinctApprover: true };
const ok = (r: TransitionResult): ApprovalState => { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.state; };

/** Base committed as v1; edits accepted and committed as v2; then submit, approve and publish through gateContext. */
function run(proposals: EditProposal[], b = base()) {
  let e = createEditor(b, proposals);
  for (const p of proposals) e = acceptProposal(e, p.id);
  if (e.proposals.some((p) => p.status !== "accepted")) throw new Error("an edit did not apply");
  let h = commitVersion(emptyHistory, b, { author: "gen", at: "t0" });
  h = commitVersion(h, e.doc, { author: "ed", at: "t1" });
  let s = ok(recordEdit(newApproval("v1", "gen"), ed, "v2"));
  s = ok(submitForApproval(s, ed));
  const approved = approve(s, ap, set, gateContext(e, h));
  const published = approved.ok ? publish(approved.state, ed, gateContext(e, h)) : approved;
  return { e, h, s, approved, published, drift: (() => { const c = checkCommittedParties(h); if (!c.ok) throw new Error(c.reason); return c.drift; })() };
}
const refusal = (r: TransitionResult) => (r.ok ? "ok" : r.code);

describe("party drift: removal and rename", () => {
  it("removing a party name from clause text blocks approve and publish", () => {
    const r = run([edit("c1", " and Jordan Example (the \"Client\")", "")]);
    expect(r.drift).toEqual([{ kind: "missing", name: "Jordan Example" }]);
    expect(refusal(r.approved)).toBe("party_drift");
    expect(r.approved.ok === false && r.approved.message).toMatch(/no longer names "Jordan Example"/);
  });
  it("removing every mention via a deleted clause is drift too", () => {
    const r = run([edit("c3", base().clauses[2].text, "", "delete"), edit("c1", "between Acme Widgets Ltd (the \"Provider\") and ", "with ")]);
    expect(r.drift.map((d) => d.kind)).toContain("missing");
    expect(r.drift.find((d) => d.kind === "missing")?.name).toBe("Acme Widgets Ltd");
  });
  it("renaming a party is caught twice: the old name is missing and the new one is unknown", () => {
    const r = run([edit("c3", "Acme Widgets Ltd will", "Acme Widgets Limited will")]);
    expect(r.drift).toEqual([{ kind: "missing", name: "Acme Widgets Ltd" }, { kind: "new_name", name: "Acme Widgets Limited" }]);
    expect(refusal(r.approved)).toBe("party_drift");
  });
  it("replacing the full name by a short form inside the same clause is drift (per-clause rule)", () => {
    expect(run([edit("c3", "Acme Widgets Ltd will", "Acme Widgets will")]).drift).toEqual([{ kind: "missing", name: "Acme Widgets Ltd" }]);
  });
  it("whole-name matching: a longer name does not count as the party", () => {
    const r = run([edit("c1", "Jordan Example (the", "Jordan Exampleton (the")]);
    expect(r.drift).toEqual([{ kind: "missing", name: "Jordan Example" }, { kind: "new_name", name: "Jordan Exampleton" }]);
  });
});

describe("party drift: newly added names", () => {
  it("a new person named next to a surviving party is caught", () => {
    const r = run([edit("c2", "The Client shall pay", "Jordan Example and Riley Sample shall pay")]);
    expect(r.drift).toEqual([{ kind: "new_name", name: "Riley Sample" }]);
    expect(refusal(r.approved)).toBe("party_drift");
    expect(r.approved.ok === false && r.approved.message).toMatch(/names "Riley Sample", who is not in the parties list/);
  });
  it("a new company in an added clause is caught", () => {
    const r = run([edit("c4", "", "Beta Holdings LLC guarantees the Client's obligations.", "add_clause")]);
    expect(r.drift).toEqual([{ kind: "new_name", name: "Beta Holdings LLC" }]);
  });
  it("a third party added to the parties sentence is caught, even as a single word", () => {
    const r = run([edit("c1", "This agreement is between Acme Widgets Ltd", "This agreement is between Zenith and Acme Widgets Ltd")]);
    expect(r.drift).toEqual([{ kind: "new_name", name: "Zenith" }]);
  });
  it.each([
    ["on behalf of", "c3", "will deliver", "will, on behalf of Quill, deliver", "Quill"],
    ["defined-term introduction", "c2", "The Client shall pay", "Morgan (the \"Payer\") shall pay", "Morgan"],
    ["role label", "c2", "The Client shall pay", "The Client, Casey, shall pay", "Casey"],
    ["ampersand name", "c3", "Acme Widgets Ltd will deliver", "Smith & Jones will deliver", "Smith & Jones"],
    ["all caps", "c3", "Acme Widgets Ltd will deliver", "Acme Widgets Ltd and NORTHWIND TRADERS will deliver", "NORTHWIND TRADERS"],
  ])("detects a name in a %s position", (_label, clauseId, before, after, name) => {
    const r = run([edit(clauseId, before, after)]);
    expect(r.drift.filter((d) => d.kind === "new_name").map((d) => d.name)).toEqual([name]);
    expect(refusal(r.approved)).toBe("party_drift");
  });
  it("case and whitespace variants of a party name are the party, not a new name", () => {
    const r = run([
      edit("c2", "The Client shall pay", "JORDAN   EXAMPLE shall pay"),
      edit("c3", "Acme Widgets Ltd will", "acme widgets  ltd will"),
    ]);
    expect(r.drift).toEqual([]);
    expect(r.published.ok).toBe(true);
  });
  it("documented limit: an all lower-case new name is not a candidate", () => {
    expect(run([edit("c2", "The Client shall pay", "The Client and riley sample shall pay")]).drift).toEqual([]);
  });
});

describe("party drift: legitimate edits still publish", () => {
  it.each([
    ["a changed number", [edit("c2", "30 days", "14 days")]],
    ["a new defined-term clause", [edit("c2", "", "Confidential Information means all non-public information shared under this Agreement.", "add_clause")]],
    ["references and dates", [edit("c3", "Schedule A", "Schedule B, Section 4.2 and Exhibit C, from the Effective Date")]],
    ["sentence-start words before a party", [edit("c2", "The Client shall pay", "If Acme Widgets Ltd so requests, the Client shall pay")]],
    ["a short form of a party name in a new place", [edit("c2", "shall pay the Fees", "shall pay Acme Widgets the Fees")]],
    ["a role word for a party", [edit("c2", "The Client shall pay", "Upon Termination the Client shall pay")]],
    ["common capitalised drafting terms", [edit("c2", "", "Neither Party is liable for a Force Majeure Event. Payment is by Bank Transfer in US Dollars, Monday to Friday excluding Public Holidays, under the Data Protection Act 2018.", "add_clause")]],
    ["a job title next to a party", [edit("c1", "Jordan Example (the", "Jordan Example, Chief Executive Officer (the")]],
    ["a proper noun already in the base", [edit("c4", "England and Wales", "England and Wales, and the courts of England")]],
  ])("%s", (_label, proposals) => {
    const r = run(proposals as EditProposal[]);
    expect(r.drift).toEqual([]);
    expect(refusal(r.approved)).toBe("ok");
    expect(r.published.ok && r.published.state.status).toBe("published");
  });
  it("an unedited document publishes", () => {
    const r = run([]);
    expect(r.published.ok && r.published.state.status).toBe("published");
  });
});

describe("review follow-ups: detection", () => {
  it.each([
    ["a word attached after a party name", "c3", "Acme Widgets Ltd will", "Acme Widgets Ltd Holdings will", "Holdings"],
    ["a word attached before a party name", "c3", "Acme Widgets Ltd will", "New Acme Widgets Ltd will", "New"],
    ["a name joined to a party by &", "c3", "Acme Widgets Ltd will", "Acme Widgets Ltd & Zenith will", "Zenith"],
    ["a name listed after a party with and", "c3", "Acme Widgets Ltd will", "Acme Widgets Ltd and Zenith will", "Zenith"],
    ["a name listed before a party with a comma", "c1", "between Acme Widgets Ltd", "between Zenith, Acme Widgets Ltd", "Zenith"],
    ["a title and one name", "c2", "The Client shall pay", "Mr Riley shall pay", "Riley"],
    ["a dotted title and one name", "c2", "The Client shall pay", "Dr. Riley shall pay", "Riley"],
    ["a role label before a title", "c2", "The Client shall pay", "The guarantor, Mr Riley, shall pay", "Riley"],
  ])("catches %s", (_label, clauseId, before, after, name) => {
    const r = run([edit(clauseId, before, after)]);
    expect(r.drift.filter((d) => d.kind === "new_name").map((d) => d.name)).toEqual([name]);
    expect(refusal(r.approved)).toBe("party_drift");
  });
  it.each([
    ["possessives of party names", "c2", "The Client shall pay the Fees", "Jordan Example's obligation is to pay Acme Widgets Ltd's Fees"],
    ["lower-case words after a role label", "c2", "The Client shall pay", "The Client, acting reasonably, shall pay"],
    ["lower-case words after between", "c2", "The Client shall pay the Fees", "Any dispute between delivery and acceptance shall be settled and the Client shall pay the Fees"],
    ["lower-case words after on behalf of", "c3", "will deliver", "will, on behalf of itself and its employees, deliver"],
    ["a role label before lower-case words", "c2", "The Client shall pay", "The Client: shall pay"],
    ["an ALL-CAPS disclaimer", "c3", "", "TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW THE SERVICES ARE PROVIDED AS IS.", "add_clause"],
    ["capitalised operational terms", "c3", "", "Key Performance Indicators, Change Control Procedure and Good Industry Practice apply; Insolvency Event has its usual meaning.", "add_clause"],
  ])("does not flag %s", (_label, clauseId, before, after, op = "replace") => {
    const r = run([edit(clauseId, before, after, op as EditProposal["op"])]);
    expect(r.drift).toEqual([]);
    expect(r.published.ok).toBe(true);
  });
  it("a trailing mark, soft hyphen or underscore makes it a different word", () => {
    for (const tail of ["̶", "́", "_x"]) {
      expect(run([edit("c3", "Acme Widgets Ltd will", `Acme Widgets Ltd${tail} will`)]).drift.map((d) => d.kind), JSON.stringify(tail)).toContain("missing");
    }
    // A soft hyphen is now refused by the editor itself; the drift check must still catch it as a second layer.
    const soft = edit("c3", "Acme Widgets Ltd will", "Acme Widgets Ltd\u00ad will");
    expect(acceptProposal(createEditor(base(), [soft]), soft.id).proposals[0].status).toBe("conflict");
    const softDoc = { ...base(), clauses: base().clauses.map((c) => (c.id === "c3" ? { ...c, text: c.text.replace("Acme Widgets Ltd will", "Acme Widgets Ltd\u00ad will") } : c)) };
    expect(partyDriftBetween(base(), softDoc).map((d) => d.kind)).toContain("missing");
  });
  it("long input is checked quickly, and text over the limit is refused rather than scanned", () => {
    const words = Array.from({ length: 3_000 }, (_, i) => `Word${String.fromCharCode(97 + (i % 26))}`).join(" ");
    for (const text of [words, "A ".repeat(9_000), "Aa" + " ".repeat(19_000) + "x", "Acme Widgets Ltd ".repeat(1_000), "between ".repeat(2_000)]) {
      const t0 = performance.now();
      const r = run([edit("c4", "", text.slice(0, MAX_CHECKED_CLAUSE), "add_clause")]);
      expect(performance.now() - t0, text.slice(0, 20)).toBeLessThan(1_500);
      expect(["ok", "party_drift"]).toContain(refusal(r.approved));
    }
    const b = base();
    const long = { ...b, clauses: [...b.clauses, { id: "x", text: "x".repeat(MAX_CHECKED_CLAUSE + 1) }] };
    const h = commitVersion(commitVersion(emptyHistory, b, { author: "gen", at: "t0" }), long, { author: "ed", at: "t1" });
    const s = ok(submitForApproval(ok(recordEdit(newApproval("v1", "gen"), ed, "v2")), ed));
    const tooLong = approve(s, ap, set, { currentVersionId: "v2", history: h });
    expect(refusal(tooLong)).toBe("party_check_missing");
    expect(tooLong.ok === false && tooLong.message).toMatch(/longer than/);
  });
  it("invisible characters inside a new name do not hide it", () => {
    for (const ch of ["\u200b", "\u00ad", "\u2060", "\u200d"]) {
      // refused by the editor first ...
      const p = edit("c4", "", `Zen${ch}ith Holdings guarantees the Client's obligations.`, "add_clause");
      expect(acceptProposal(createEditor(base(), [p]), p.id).proposals[0].status, JSON.stringify(ch)).toBe("conflict");
      // ... and still caught by the drift check as a second layer
      const doc = { ...base(), clauses: [...base().clauses.slice(0, 4), { id: "x", text: `Zen${ch}ith Holdings guarantees the Client's obligations.` }, base().clauses[4]] };
      expect(partyDriftBetween(base(), doc).map((d) => d.kind), JSON.stringify(ch)).toEqual(["new_name"]);
    }
  });
  it("names inside ALL-CAPS passages are found", () => {
    expect(run([edit("c4", "", "ZENITH HOLDINGS SHALL INDEMNIFY THE CLIENT.", "add_clause")]).drift.map((d) => d.name)).toEqual(["ZENITH HOLDINGS"]);
    expect(run([edit("c4", "", "NEITHER ACME WIDGETS LTD NOR ZENITH HOLDINGS SHALL BE LIABLE.", "add_clause")]).drift.map((d) => d.name)).toEqual(["ZENITH HOLDINGS"]);
    expect(run([edit("c4", "", "THE SERVICES ARE PROVIDED AS IS WITHOUT ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.", "add_clause")]).drift).toEqual([]);
  });
  it("modal verbs are not stripped as leading words, so first names like Will and May survive", () => {
    expect(run([edit("c4", "", "Payment is guaranteed by Will Smith.", "add_clause")]).drift.map((d) => d.name)).toEqual(["Will Smith"]);
    expect(run([edit("c4", "", "Payment is guaranteed by May Jones.", "add_clause")]).drift.map((d) => d.name)).toEqual(["May Jones"]);
  });
  it("swapping roles in the parties sentence is drift", () => {
    const r = run([edit("c1", "Acme Widgets Ltd (the \"Provider\") and Jordan Example (the \"Client\")", "Jordan Example (the \"Provider\") and Acme Widgets Ltd (the \"Client\")")]);
    expect(r.drift.map((d) => d.kind).sort()).toEqual(["role_mismatch", "role_mismatch"]);
    expect(refusal(r.approved)).toBe("party_drift");
  });
  it("extra spaces or blank-rendering characters between the words of a name do not hide it", () => {
    for (const gap of [" ".repeat(9), " ".repeat(40), "\t\t", "\u2800", "\u3164", " \u00a0 "]) {
      expect(run([edit("c4", "", `Payment by Zenith${gap}Holdings.`, "add_clause")]).drift.map((d) => d.kind), JSON.stringify(gap)).toEqual(["new_name"]);
    }
    expect(run([edit("c1", "between Acme Widgets Ltd", "between Zenith,          Acme Widgets Ltd")]).drift.map((d) => d.name)).toEqual(["Zenith"]);
  });
  it("a first name that is also a preposition (Per) is kept", () => {
    expect(run([edit("c4", "", "Payment is guaranteed by Per Andersson.", "add_clause")]).drift.map((d) => d.name)).toEqual(["Per Andersson"]);
  });
  it.each([
    ["a description before the role", "Acme Widgets Ltd (the \"Provider\") and Jordan Example (the \"Client\")", "Jordan Example, a company registered in England (the \"Provider\") and Acme Widgets Ltd of 1 High Street (the \"Client\")"],
    ["hereinafter", "Acme Widgets Ltd (the \"Provider\") and Jordan Example (the \"Client\")", "Jordan Example (hereinafter the \"Provider\") and Acme Widgets Ltd (hereinafter the \"Client\")"],
  ])("a role swap with %s is drift", (_label, before, after) => {
    const r = run([edit("c1", before, after)]);
    expect(r.drift.map((d) => d.kind)).toContain("role_mismatch");
    expect(refusal(r.approved)).toBe("party_drift");
  });
  it("role labels and 'as the Role' swaps are drift, ordinary prose is not", () => {
    expect(run([edit("c4", "", "Provider: Jordan Example. Client: Acme Widgets Ltd.", "add_clause")]).drift.map((d) => d.kind)).toContain("role_mismatch");
    expect(run([edit("c4", "", "Jordan Example, as the Provider, keeps the records.", "add_clause")]).drift.map((d) => d.kind)).toContain("role_mismatch");
    expect(run([edit("c4", "", "Jordan Example acts as provider of the data. Client: Jordan Example.", "add_clause")]).drift).toEqual([]);
    expect(run([edit("c4", "", "Acme Widgets Ltd, as the Provider, keeps the records.", "add_clause")]).drift).toEqual([]);
  });
  it("two parties sharing a role is not a swap", () => {
    const b: DraftDocument = { ...base(), parties: [{ role: "Client", name: "Acme Widgets Ltd" }, { role: "Client", name: "Jordan Example" }, { role: "Provider", name: "Zed Corp" }] };
    const r = run([edit("c4", "", "Acme Widgets Ltd (the \"Client\") and Zed Corp (the \"Provider\") agree. Client: Jordan Example.", "add_clause")], b);
    expect(r.drift.filter((d) => d.kind === "role_mismatch")).toEqual([]);
    const swap = run([edit("c4", "", "Provider: Jordan Example.", "add_clause")], b);
    expect(swap.drift.map((d) => d.kind)).toContain("role_mismatch");
  });
  it("swap forms with 'referred to as', a dotted-I elsewhere, and a baseline possessive", () => {
    expect(run([edit("c1", "Jordan Example (the \"Client\")", "Jordan Example (hereinafter referred to as the \"Provider\")")]).drift.map((d) => d.kind)).toContain("role_mismatch");
    expect(run([edit("c4", "", "Provider: Jordan Example. Signed in \u0130stanbul.", "add_clause")]).drift.map((d) => d.kind)).toContain("role_mismatch");
    const b = base();
    const withPossessive = { ...b, clauses: b.clauses.map((c) => (c.id === "c4" ? { ...c, text: `${c.text} Jordan Example, as the Provider's licensee, may use the Services.` } : c)) };
    const r = run([edit("c1", "Jordan Example (the \"Client\")", "Jordan Example (the \"Provider\")")], withPossessive);
    expect(r.drift.map((d) => d.kind)).toContain("role_mismatch");
  });
  it("combining marks that render blank do not split a name", () => {
    for (const ch of ["\u034f", "\u17b4", "\u0301"]) {
      expect(run([edit("c4", "", `Payment by Zenith ${ch} Holdings.`, "add_clause")]).drift.map((d) => d.kind), JSON.stringify(ch)).toEqual(["new_name"]);
    }
  });
  it("Per Annum and Per Diem are drafting terms", () => {
    expect(run([edit("c2", "30 days", "30 days at a rate Per Annum plus a Per Diem")]).drift).toEqual([]);
  });
  it("worst-case patterns stay fast, and an oversized document is refused", () => {
    const b = base();
    const heavy = { ...b, clauses: [...b.clauses, ...Array.from({ length: 4 }, (_, i) => ({ id: `h${i}`, text: 'A("'.repeat(6_000) }))] };
    const h = commitVersion(commitVersion(emptyHistory, b, { author: "gen", at: "t0" }), heavy, { author: "ed", at: "t1" });
    const t0 = performance.now();
    const c = checkCommittedParties(h);
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(c.ok).toBe(true);
    const huge = { ...b, clauses: [...b.clauses, ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, text: "word ".repeat(3_900) }))] };
    const h2 = commitVersion(commitVersion(emptyHistory, b, { author: "gen", at: "t0" }), huge, { author: "ed", at: "t1" });
    expect(checkCommittedParties(h2)).toMatchObject({ ok: false, reason: expect.stringMatching(/in total/) });
  });
  it("realistic legitimate additions are not flagged", () => {
    const text = "The Order Form sets the Subscription Fees and Due Date. A Change Request under the Master Services Agreement or the Non-Disclosure Agreement goes to the Steering Committee. Usage Data and Service Credits are handled under UK GDPR and the Business Continuity Plan; Background IP stays with its owner in the United States.";
    const r = run([edit("c4", "", text, "add_clause"), edit("c2", "The Client shall pay", "The Client: shall pay")]);
    expect(r.drift).toEqual([]);
    expect(r.published.ok).toBe(true);
  });
});

describe("party drift gate fails closed", () => {
  const h1 = () => commitVersion(emptyHistory, base(), { author: "gen", at: "t0" });
  const pending = () => ok(submitForApproval(newApproval("v1", "ed"), ed));
  it("approve and publish refuse without any gate context", () => {
    const none = undefined as unknown as Parameters<typeof approve>[3];
    expect(refusal(approve(pending(), ap, set, none))).toBe("party_check_missing");
    const approvedState = ok(approve(pending(), ap, set, { currentVersionId: "v1", history: h1() }));
    expect(refusal(publish(approvedState, ed, none as unknown as Parameters<typeof publish>[2]))).toBe("party_check_missing");
  });
  it("approve and publish refuse without a history", () => {
    const noHistory = { currentVersionId: "v1" } as unknown as Parameters<typeof approve>[3];
    expect(refusal(approve(pending(), ap, set, noHistory))).toBe("party_check_missing");
    const approvedState = ok(approve(pending(), ap, set, { currentVersionId: "v1", history: h1() }));
    expect(refusal(publish(approvedState, ed, { openProposals: 0, ...noHistory }))).toBe("party_check_missing");
    expect(refusal(publish(approvedState, ed, { openProposals: 0, currentVersionId: "v1", history: h1() }))).toBe("ok");
  });
  it("an unfrozen history (copied, cloned or restored from JSON) is refused; the frozen check catches mistakes, not forgery", () => {
    const fake = { versions: [{ id: "v1", number: 1, doc: base(), author: "x", at: "t", note: "", kind: "edit" }] } as unknown as VersionHistory;
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: fake }))).toBe("party_check_missing");
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: { ...h1() } }))).toBe("party_check_missing");
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: structuredClone(h1()) }))).toBe("party_check_missing");
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: JSON.parse(JSON.stringify(h1())) }))).toBe("party_check_missing");
  });
  it("the history's latest version must be the version being approved", () => {
    const h2 = commitVersion(h1(), base(), { author: "ed", at: "t1" });
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: h2 }))).toBe("party_check_missing");
  });
  it("the baseline is the first version, so a new session started from a drifted version is still drift", () => {
    let e = createEditor(base(), [edit("c2", "The Client shall pay", "Riley Sample shall pay")]);
    e = acceptProposal(e, e.proposals[0].id);
    const h = commitVersion(h1(), e.doc, { author: "ed", at: "t1" });
    const resumed = createEditor(h.versions[1].doc, []);
    const s = ok(submitForApproval(ok(recordEdit(newApproval("v1", "gen"), ed, "v2")), ed));
    expect(refusal(approve(s, ap, set, gateContext(resumed, h)))).toBe("party_drift");
  });
  it("a history whose first version is an edit has no baseline and is refused", () => {
    const h = commitVersion(emptyHistory, { ...base(), origin: { kind: "edit" } }, { author: "ed", at: "t0" });
    expect(refusal(approve(pending(), ap, set, { currentVersionId: "v1", history: h }))).toBe("party_check_missing");
  });
  it("a committed version whose parties list changed is refused by the gate", () => {
    const b = base();
    const h = commitVersion(h1(), { ...b, parties: [b.parties[0], { role: "Provider", name: "Other Provider Ltd" }] }, { author: "ed", at: "t1" });
    const s = ok(submitForApproval(ok(recordEdit(newApproval("v1", "gen"), ed, "v2")), ed));
    const r = approve(s, ap, set, { currentVersionId: "v2", history: h });
    expect(refusal(r)).toBe("party_drift");
    expect(r.ok === false && r.message).toMatch(/parties list changed/);
    expect(partyDriftBetween(b, h.versions[1].doc).map((d) => d.kind)).toContain("parties_changed");
  });
  it("what is checked is the committed version, not the editor's working doc", () => {
    const r = run([edit("c2", "30 days", "14 days")]);
    expect(r.approved.ok).toBe(true);
    const later = edit("c2", "The Client shall pay", "Riley Sample shall pay");
    let e = createEditor(base(), [...r.e.proposals, later]);
    e = acceptProposal(e, later.id);
    // The uncommitted drift is not what would be published; committing it moves the version and needs a new approval.
    const h3 = commitVersion(r.h, e.doc, { author: "ed", at: "t2" });
    expect(refusal(publish((r.approved as { state: ApprovalState }).state, ed, gateContext(e, h3)))).toBe("stale_version");
    const s3 = ok(submitForApproval(ok(recordEdit((r.approved as { state: ApprovalState }).state, ed, "v3")), ed));
    expect(refusal(approve(s3, ap, set, gateContext(e, h3)))).toBe("party_drift");
  });
  it("publish refuses a missing or invalid open-proposal count", () => {
    const approvedState = ok(approve(pending(), ap, set, { currentVersionId: "v1", history: h1() }));
    for (const n of [undefined, NaN, -1, 1.5]) {
      expect(refusal(publish(approvedState, ed, { openProposals: n as unknown as number, currentVersionId: "v1", history: h1() })), String(n)).toBe("open_proposals");
    }
  });
  it("availableActions shows the drift as the reason approve is disabled", () => {
    const r = run([edit("c2", "The Client shall pay", "Jordan Example and Riley Sample shall pay")]);
    const a = availableActions(r.s, ap, set, gateContext(r.e, r.h));
    expect(a.approve).toEqual({ enabled: false, reason: expect.stringContaining("Riley Sample") });
  });
  it("checkCommittedParties reports why it could not run", () => {
    expect(checkCommittedParties(emptyHistory)).toEqual({ ok: false, reason: "no committed version to check" });
    expect(checkCommittedParties(undefined as unknown as VersionHistory).ok).toBe(false);
  });
});
