import type { EditProposal } from "../types";
import { DiffView } from "./DiffView";

export type ProposalActions = { accept: boolean; reject: boolean; undo: boolean };
export function proposalActions(status: EditProposal["status"]): ProposalActions {
  return {
    accept: status === "proposed" || status === "conflict",
    reject: status === "proposed" || status === "conflict" || status === "blocked",
    undo: status === "accepted" || status === "rejected",
  };
}
export const statusLabel: Record<EditProposal["status"], string> = {
  proposed: "Proposed", blocked: "Blocked", accepted: "Accepted", rejected: "Rejected", conflict: "Conflict",
};

/** Pure props-in card; the parent supplies handlers and the clause text the proposal targets. */
export function ProposalCard(props: {
  proposal: EditProposal;
  error?: string;
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
  onUndo?: (id: string) => void;
}) {
  const { proposal: p, error } = props;
  const a = proposalActions(p.status);
  const original = p.op === "add_clause" ? "" : p.before;
  const proposed = p.op === "delete" ? "" : p.op === "insert_after" ? p.before + p.after : p.after;
  return (
    <article className={`proposal proposal-${p.status}`} data-status={p.status}>
      <header><strong>{p.op.replace("_", " ")}</strong> <span className="status">{statusLabel[p.status]}</span></header>
      <DiffView original={original} proposed={proposed} />
      {p.rationale ? <p className="rationale">{p.rationale}</p> : null}
      {error ? <p role="alert" className="proposal-error">{error}</p> : null}
      <footer>
        {a.accept && <button type="button" onClick={() => props.onAccept?.(p.id)}>Accept</button>}
        {a.reject && <button type="button" onClick={() => props.onReject?.(p.id)}>Reject</button>}
        {a.undo && <button type="button" onClick={() => props.onUndo?.(p.id)}>Undo</button>}
      </footer>
    </article>
  );
}
