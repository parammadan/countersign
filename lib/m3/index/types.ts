/** Shared types of the M3 document index (owned by S4). Self-contained: no imports from the app. */

export type DocumentStatus = "active" | "superseded" | "deleted";

export type PassageInput = { id: string; page: number; text: string; binding: boolean };

/** One version of one document, as handed to `Index.put`. `status: "deleted"` is not accepted: use `remove`. */
export type IndexedDocument = {
  workspaceId: string;
  documentId: string;
  versionId: string;
  status: DocumentStatus;
  /** false: the whole document is reference material only and none of it is ever served as binding. */
  binding: boolean;
  passages: PassageInput[];
};

export type PassageFlag = "non-binding-document" | "non-binding-passage" | "injection-like";

export type IndexedPassage = {
  /** Stable within a version: exactly the id the caller supplied. Not unique across versions. */
  id: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  page: number;
  text: string;
  /** Effective binding: document, passage and the injection screen all agree. */
  binding: boolean;
  flags: PassageFlag[];
};

export type PassagesOptions = {
  /** Restrict to one document of the workspace. */
  documentId?: string;
  /** For the security reviewer only: also return passages that are not binding (binding: false, flags set). */
  includeNonBinding?: boolean;
  limit?: number;
};

export interface Index {
  /** Store a version. An active version supersedes the document's previous active version atomically. */
  put(doc: IndexedDocument): void;
  /** Make `newVersionId` (already put) the only active version of the document. */
  supersede(workspaceId: string, documentId: string, newVersionId: string): void;
  /** Delete the document, every version and every passage. Returns whether anything was removed. */
  remove(workspaceId: string, documentId: string): boolean;
  /**
   * Passages of active versions in one workspace; binding ones only unless `includeNonBinding`. Without `limit`, every
   * such passage (read in pages of one document); with `limit`, at most min(limit, LIMITS.queryLimit).
   */
  passagesFor(workspaceId: string, opts?: PassagesOptions): IndexedPassage[];
}

export type IndexStats = { documents: number; versions: number; passages: number };

export interface SqliteIndex extends Index {
  stats(workspaceId: string): IndexStats;
  close(): void;
}
