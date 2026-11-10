import { canRead } from "./policy";
import { sanitizePassage } from "./sanitize";
import type { Citation, DocumentRef, Index, User, Workspace } from "./types";

export type CitationResult = { valid: boolean; reason: string; binding?: boolean };

const MIN_QUOTE = 8;

export type VerifyContext = {
  user: User;
  workspace: Workspace;
  index: Index;
  /** Document-level metadata (restrictions) for the permission check. */
  documentRef(workspaceId: string, documentId: string): DocumentRef | undefined;
};

/**
 * A citation is valid only if: it names the caller's workspace; the passage exists and is active in that
 * workspace's index; the caller may read the document; the passage is not instruction-like; the quote is a
 * verbatim (exact, case-sensitive, non-trivial) substring of the sanitised passage text the model saw; and a claim of "binding" is true.
 */
export function verifyCitation(c: Citation, ctx: VerifyContext): CitationResult {
  const bad = (reason: string): CitationResult => ({ valid: false, reason });
  if (!c || typeof c.quote !== "string" || typeof c.passageId !== "string" || typeof c.documentId !== "string") return bad("malformed");
  if (c.workspaceId !== ctx.workspace.id) return bad("cross-workspace");
  if (c.quote.replace(/\s/g, "").length < MIN_QUOTE) return bad("quote-too-short");
  // Look only inside the caller's own workspace partition, active passages only.
  // compat: scoped to the cited document (a bounded read) instead of loading the whole workspace per citation. An id
  // the index rejects (empty, too long, control characters) is a forged citation: same answer as a missing one.
  let scoped: ReturnType<Index["passagesFor"]>;
  try {
    scoped = ctx.index.passagesFor(ctx.workspace.id, { includeNonBinding: true, documentId: c.documentId });
  } catch (e) {
    // Only an id the index refuses (S4: IndexError code "invalid") is a forged citation; anything else (closed index,
    // busy or broken database) is an infrastructure failure and must not read as "not found".
    if (e instanceof Error && e.name === "IndexError" && (e as Error & { code?: string }).code === "invalid") return bad("not-found-or-unauthorized");
    throw e;
  }
  const hit = scoped.find((p) => p.workspaceId === ctx.workspace.id && p.documentId === c.documentId && p.id === c.passageId);
  // One reason for missing/inactive/unauthorised so callers cannot probe which restricted documents exist.
  if (!hit) return bad("not-found-or-unauthorized");
  // compat: a citation of a version other than the active one is stale, even if the passage id matches.
  if (c.versionId !== undefined && c.versionId !== hit.versionId) return bad("not-found-or-unauthorized");
  const ref = ctx.documentRef(ctx.workspace.id, c.documentId);
  if (!ref || ref.status !== "active" || !canRead(ctx.user, ctx.workspace, ref)) return bad("not-found-or-unauthorized");
  const san = sanitizePassage(hit);
  if (!san.evidence) return bad("passage-not-evidence");
  // Verify against the text the model was shown (normalised, fence-neutralised), not the raw stored text.
  if (!san.text.includes(c.quote)) return bad("quote-not-verbatim");
  if (c.claimsBinding && !san.binding) return bad("not-binding");
  return { valid: true, reason: "ok", binding: san.binding };
}
