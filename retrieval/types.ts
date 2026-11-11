/** Public types of the retrieval module. Self-contained: no imports from the app, no network, no model calls. */

export type Access = { roles?: string[]; userIds?: string[] };

export type DocumentInput = {
  workspaceId: string;
  docId: string;
  title: string;
  /** Monotonic version number; a higher version replaces the stored one, a lower or equal one is ignored. */
  version: number;
  /** One string per source page; page numbers in citations are 1-based indexes into this array. */
  pages: string[];
  /** Default deny: a document with neither roles nor userIds is visible to nobody. The role "*" means everyone. */
  access: Access;
};

export type AddStatus = "added" | "replaced" | "unchanged" | "duplicate" | "stale";
/** `duplicateOf` is for trusted callers only: it may name a document the end user cannot see. */
export type AddResult = { status: AddStatus; docId: string; duplicateOf?: string };

export type SearchUser = { id: string; role: string };

export type Citation = {
  docId: string;
  title: string;
  /** 1-based page number in the source document. */
  page: number;
  chunkId: string;
  /** The chunk: a verbatim, contiguous run of the page text. */
  text: string;
  /** The best sentence of the chunk for this query: a verbatim substring of `text` (and so of the page). */
  quote: string;
  score: number;
};

export type SearchStatus = "ok" | "no_evidence" | "ambiguous";
export type SearchResult = { status: SearchStatus; results: Citation[] };

export type SearchInput = { workspaceId: string; user: SearchUser; query: string; k?: number };

export type IndexStats = { documents: number; chunks: number };

export interface RetrievalIndex {
  addDocument(doc: DocumentInput): AddResult;
  removeDocument(workspaceId: string, docId: string): boolean;
  updateAccess(workspaceId: string, docId: string, access: Access): boolean;
  search(input: SearchInput): SearchResult;
  /** Counts for one workspace (never global), for tests and health checks. */
  stats(workspaceId: string): IndexStats;
}
