import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, ProposalCard, ApprovalBar, proposalActions } from "@/lib/m23/m23-editor/ui";
import { newApproval, submitForApproval, availableActions, commitVersion, emptyHistory } from "@/lib/m23/m23-editor";
import type { EditProposal } from "@/lib/m23/m23-editor";

const p = (o: Partial<EditProposal> = {}): EditProposal => ({
  id: "p1", clauseId: "c1", op: "replace", before: "30 days", after: "14 days", rationale: "Shorter payment term", status: "proposed", ...o,
});
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("DiffView", () => {
  it("renders insertions and deletions with ins/del", () => {
    const h = html(createElement(DiffView, { original: "pay in 30 days", proposed: "pay in 14 days" }));
    expect(h).toContain("<del class=\"diff-del\">30</del>");
    expect(h).toContain("<ins class=\"diff-ins\">14</ins>");
  });
  it("escapes markup in agreement text", () => {
    const h = html(createElement(DiffView, { original: "a", proposed: "a <script>x</script>" }));
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("ProposalCard", () => {
  it("offers actions by status", () => {
    expect(proposalActions("proposed")).toEqual({ accept: true, reject: true, undo: false });
    expect(proposalActions("accepted")).toEqual({ accept: false, reject: false, undo: true });
    expect(proposalActions("rejected").undo).toBe(true);
    expect(proposalActions("blocked")).toEqual({ accept: false, reject: true, undo: false });
    expect(proposalActions("conflict").accept).toBe(true);
  });
  it("renders rationale, buttons and conflict error", () => {
    const h = html(createElement(ProposalCard, { proposal: p({ status: "conflict" }), error: "`before` text not found in clause" }));
    expect(h).toContain("Shorter payment term");
    expect(h).toContain("role=\"alert\"");
    expect(h).toContain(">Accept<");
    expect(h).not.toContain(">Undo<");
    expect(html(createElement(ProposalCard, { proposal: p({ status: "accepted" }) }))).toContain(">Undo<");
  });
  it("add_clause shows all text as inserted, delete as removed", () => {
    expect(html(createElement(ProposalCard, { proposal: p({ op: "add_clause", before: "", after: "New clause." }) }))).toContain("<ins");
    expect(html(createElement(ProposalCard, { proposal: p({ op: "delete" }) }))).toContain("<del");
  });
  it("wires accept, reject and undo handlers", () => {
    const calls: string[] = [];
    const find = (n: unknown, label: string): { onClick: () => void } | undefined => {
      if (!n || typeof n !== "object") return undefined;
      if (Array.isArray(n)) return n.map((c) => find(c, label)).find(Boolean);
      const el = n as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
      if (el.type === "button" && el.props?.children === label) return el.props as { onClick: () => void };
      return find(el.props?.children, label);
    };
    const handlers = { onAccept: (id: string) => calls.push("a" + id), onReject: (id: string) => calls.push("r" + id), onUndo: (id: string) => calls.push("u" + id) };
    const open = ProposalCard({ proposal: p(), ...handlers });
    find(open, "Accept")!.onClick();
    find(open, "Reject")!.onClick();
    find(ProposalCard({ proposal: p({ status: "accepted" }), ...handlers }), "Undo")!.onClick();
    expect(calls).toEqual(["ap1", "rp1", "up1"]);
  });
});

describe("ApprovalBar", () => {
  const d = { schema: 1 as const, title: "T", parties: [{ role: "Client", name: "Sample Client" }], clauses: [{ id: "c1", text: "Pay in 30 days." }], origin: { kind: "generated" as const } };
  const ctx = { openProposals: 0, currentVersionId: "v1", history: commitVersion(emptyHistory, d, { author: "gen", at: "t0" }) };
  const set = { requireDistinctApprover: true };
  it("shows submit on draft with no disabled buttons", () => {
    const s = newApproval("v1", "ed");
    const h = html(createElement(ApprovalBar, { status: s.status, actions: availableActions(s, { userId: "ed", role: "editor" }, set, ctx) }));
    expect(h).toContain("Draft");
    expect(h).toContain("Submit for approval");
    expect(h).not.toContain("disabled");
  });
  it("disables approve for the last editor with the reason as title", () => {
    const r = submitForApproval(newApproval("v1", "ed"), { userId: "ed", role: "approver" });
    if (!r.ok) throw new Error("x");
    const h = html(createElement(ApprovalBar, { status: r.state.status, actions: availableActions(r.state, { userId: "ed", role: "approver" }, set, ctx) }));
    expect(h).toContain("Waiting for approval");
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*title="the approver must differ from the last editor"[^>]*>Approve/);
    expect(h).toContain("Request changes");
  });
  it("shows no actions once published", () => {
    const off = { enabled: false };
    const h = html(createElement(ApprovalBar, { status: "published", actions: { submit: off, approve: off, requestChanges: off, publish: off } }));
    expect(h).toContain("Published");
    expect(h).not.toContain("<button");
  });
});
