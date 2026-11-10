import type { Index, IndexedDocument, IndexedPassage, PassageFlag, PassagesOptions } from "./types";

const INJECTION = /ignore (all |any )?(the )?(previous|prior|above) instructions|disregard (the )?(previous|above)|system prompt/i;

/** In-memory Index for tests and local use; mirrors S4's contract (effective binding, flags, active-only). */
export class MemoryIndex implements Index {
  private docs = new Map<string, Map<string, IndexedDocument>>();

  put(doc: IndexedDocument): void {
    let ws = this.docs.get(doc.workspaceId);
    if (!ws) this.docs.set(doc.workspaceId, (ws = new Map()));
    // like S4: a non-active put never displaces the active version
    if (doc.status !== "active" && ws.get(doc.documentId)?.status === "active") return;
    ws.set(doc.documentId, structuredClone(doc));
  }

  /** Marks the current version superseded when it differs from newVersionId (the new version arrives via put). */
  supersede(workspaceId: string, documentId: string, newVersionId: string): void {
    const d = this.docs.get(workspaceId)?.get(documentId);
    if (d && d.versionId !== newVersionId) d.status = "superseded";
  }

  remove(workspaceId: string, documentId: string): boolean {
    return this.docs.get(workspaceId)?.delete(documentId) ?? false;
  }

  passagesFor(workspaceId: string, opts: PassagesOptions = {}): IndexedPassage[] {
    const out: IndexedPassage[] = [];
    for (const d of this.docs.get(workspaceId)?.values() ?? []) {
      if (d.status !== "active" || (opts.documentId && opts.documentId !== d.documentId)) continue;
      for (const p of d.passages) {
        const flags: PassageFlag[] = [];
        if (!d.binding) flags.push("non-binding-document");
        if (!p.binding) flags.push("non-binding-passage");
        if (INJECTION.test(p.text)) flags.push("injection-like");
        const binding = flags.length === 0;
        if (!binding && !opts.includeNonBinding) continue;
        out.push({ id: p.id, workspaceId: d.workspaceId, documentId: d.documentId, versionId: d.versionId, page: p.page, text: p.text, binding, flags });
      }
    }
    return out;
  }
}
