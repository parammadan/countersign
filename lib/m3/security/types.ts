// M3 security types: the index's own types, plus the principal, workspace and document references the policy
// decides on, and the citation shape the verifier checks.
import type { DocumentStatus } from "../index/types";
export type { IndexedDocument, IndexedPassage, Index, PassageFlag, PassageInput, PassagesOptions } from "../index/types";

export type DocStatus = DocumentStatus;
export type Role = "owner" | "admin" | "staff" | "viewer";
export type User = { id: string; disabled?: boolean; memberships: { workspaceId: string; role: Role }[] };
export type Workspace = { id: string };
export type DocumentRef = {
  workspaceId: string;
  documentId: string;
  status: DocStatus;
  /** Document-level restrictions. Absent = any member may read an active document. */
  restrictions?: { minRole?: Role; allowUserIds?: string[]; denyUserIds?: string[] };
};
/** A citation as the verifier sees it: always with the caller's workspace; `versionId` must be the active one. */
export type Citation = { workspaceId: string; documentId: string; versionId?: string; passageId: string; quote: string; claimsBinding?: boolean };
