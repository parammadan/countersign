// M3 retrieval types: the index's own types, plus the citation shape retrieval returns.
export type { DocumentStatus, IndexedDocument, IndexedPassage, Index, PassageFlag, PassageInput, PassagesOptions } from "../index/types";

export type Citation = { documentId: string; versionId: string; passageId: string; page: number; quote: string };
