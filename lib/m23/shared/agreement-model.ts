// Shared agreement types. Owned by S1 (generation); other workstreams import from here once merged.
export type Clause = { id: string; number?: string; heading?: string; text: string; locked?: boolean };
export type DraftDocument = { schema: 1; title: string; parties: { role: string; name: string }[]; clauses: Clause[]; origin: { kind: "generated" | "upload" | "edit"; versionId?: string } };
export type EditProposal = { id: string; clauseId: string; op: "replace" | "insert_after" | "delete" | "add_clause"; before: string; after: string; rationale: string; status: "proposed" | "blocked" | "accepted" | "rejected" | "conflict" };
export interface ModelProvider { name: string; complete(req: { system: string; prompt: string; schema?: unknown }): Promise<unknown> }
