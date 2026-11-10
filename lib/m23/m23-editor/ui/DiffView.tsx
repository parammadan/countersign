import { diffWords, type DiffSegment } from "../diff";

export const segmentClass = (op: DiffSegment["op"]) => (op === "insert" ? "diff-ins" : op === "delete" ? "diff-del" : "diff-eq");

/** Pure props-in: shows original vs proposed with insertions and deletions marked. */
export function DiffView({ original, proposed }: { original: string; proposed: string }) {
  const segs = diffWords(original, proposed);
  return (
    <p className="diff-view" aria-label="Changes">
      {segs.map((s, i) =>
        s.op === "insert" ? <ins key={i} className={segmentClass(s.op)}>{s.text}</ins>
        : s.op === "delete" ? <del key={i} className={segmentClass(s.op)}>{s.text}</del>
        : <span key={i} className={segmentClass(s.op)}>{s.text}</span>,
      )}
    </p>
  );
}
