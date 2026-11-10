// Local copy of S1's DraftDocument shape (modules/shared/agreement-model.ts on claude/S1-generate).
// Copied, not imported, because that branch is unmerged. Keep structurally identical.
export type Clause = { id: string; number?: string; heading?: string; text: string; locked?: boolean };
export type DraftDocument = {
  schema: 1;
  title: string;
  parties: { role: string; name: string }[];
  clauses: Clause[];
  origin: { kind: "generated" | "upload" | "edit"; versionId?: string };
};

// Resolved clause label: explicit number if given, otherwise 1-based position.
export function clauseLabel(c: Clause, index: number): string {
  const n = c.number?.trim();
  return n ? n : `${index + 1}.`;
}
