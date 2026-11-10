// M3 pipeline glue: S4 index -> permission filter (S6 canRead) -> S5 search/compare -> S6 verifyCitation, and the
// two-stage answer (search with no floor, then the evidence-sufficiency step). Ported from the reviewed sandbox
// (agreementos-agents feat/m3-evidence). Pure functions over the M3 modules; no I/O of its own.
import type { Index, IndexedPassage, PassagesOptions } from "./index/types";
import { compare, search, searchDetailed, type Candidate, type CompareResult, type Hit, type SearchRequest } from "./retrieve/retrieve";
import { decide, type EvidenceDecision, type EvidenceRequest } from "./retrieve/evidence";
import type { Citation as S5Citation } from "./retrieve/types";
import { canRead } from "./security/policy";
import { verifyCitation } from "./security/citations";
import type { Citation as S6Citation, DocumentRef, User, Workspace } from "./security/types";

export type PipelineContext = {
  user: User;
  workspace: Workspace;
  index: Index;
  /** Required (no silent "everyone may read"): return undefined only for documents deliberately unrestricted. Document-level restrictions; status is taken as "active" because the index only returns active versions. */
  restrictions: (workspaceId: string, documentId: string) => DocumentRef["restrictions"];
};

const refOf = (ctx: PipelineContext, workspaceId: string, documentId: string): DocumentRef => ({
  workspaceId,
  documentId,
  status: "active",
  restrictions: ctx.restrictions(workspaceId, documentId),
});

/** Citation-shape adapter: S4/S5 (versionId, page) -> S6 (workspaceId, versionId, claimsBinding). */
export function toS6Citation(c: S5Citation, workspaceId: string, claimsBinding = true): S6Citation {
  return { workspaceId, documentId: c.documentId, versionId: c.versionId, passageId: c.passageId, quote: c.quote, claimsBinding };
}

/** An Index view that hides every document the user may not read (and every other workspace). */
export function readableIndex(ctx: PipelineContext): Index {
  const keep = (p: IndexedPassage) => p.workspaceId === ctx.workspace.id && canRead(ctx.user, ctx.workspace, refOf(ctx, p.workspaceId, p.documentId));
  const deny = () => {
    throw new Error("read-only view");
  };
  return {
    put: deny,
    supersede: deny,
    remove: deny,
    passagesFor(workspaceId: string, opts?: PassagesOptions) {
      if (workspaceId !== ctx.workspace.id) return [];
      return ctx.index.passagesFor(workspaceId, opts).filter(keep);
    },
  };
}

export type PipelineResult = {
  hits: Hit[];
  rejected: { hit: Hit; reason: string }[];
  truncated: boolean;
  skippedDocuments: string[];
  /** S5 abstained (relevance floor) or every hit failed verification: answer "not found in your documents". */
  abstained: boolean;
};

/** Search as `ctx.user`: permission-filtered S5 search, every citation re-verified by S6; unverifiable hits are dropped. */
export function secureSearch(ctx: PipelineContext, req: Omit<SearchRequest, "workspaceId">): PipelineResult {
  const r = search(readableIndex(ctx), { ...req, workspaceId: ctx.workspace.id });
  const hits: Hit[] = [];
  const rejected: PipelineResult["rejected"] = [];
  for (const h of r.hits) {
    const v = verifyCitation(toS6Citation(h.citation, ctx.workspace.id), { user: ctx.user, workspace: ctx.workspace, index: ctx.index, documentRef: (w, d) => refOf(ctx, w, d) });
    if (v.valid) hits.push(h);
    else rejected.push({ hit: h, reason: v.reason });
  }
  return { hits, rejected, truncated: r.truncated, skippedDocuments: r.skippedDocuments, abstained: hits.length === 0 };
}

/** Comparison as `ctx.user`; citations verified, unverifiable ones removed (a row left empty is reported `missing`). */
export function secureCompare(ctx: PipelineContext, req: Omit<SearchRequest, "workspaceId">): CompareResult {
  const r = compare(readableIndex(ctx), { ...req, workspaceId: ctx.workspace.id });
  const vctx = { user: ctx.user, workspace: ctx.workspace, index: ctx.index, documentRef: (w: string, d: string) => refOf(ctx, w, d) };
  return {
    ...r,
    rows: r.rows.map((row) => {
      const citations = row.citations.filter((c) => verifyCitation(toS6Citation(c, ctx.workspace.id), vctx).valid);
      return { ...row, citations, missing: row.missing || (citations.length === 0 && !row.omitted), omitted: row.omitted && citations.length === 0 };
    }),
  };
}

export type AnswerResult = PipelineResult & {
  decision: EvidenceDecision;
  /** stage 1 hits that passed S6 verification, before stage 2 */
  candidates: Hit[];
  /** the (sanitised) passage behind each of `hits`, same order */
  passages: IndexedPassage[];
};

/**
 * Two-stage answer as `ctx.user`: permission-filtered stage-1 search with no relevance floor, every citation re-verified
 * by S6, then the evidence-sufficiency step over the verified candidates only. Answers with the verified stage-1 hits
 * or abstains (no hits).
 */
export function secureAnswer(ctx: PipelineContext, req: Omit<EvidenceRequest, "workspaceId">): AnswerResult {
  const view = readableIndex(ctx);
  const d = searchDetailed(view, { ...req, workspaceId: ctx.workspace.id, minRelevance: 0 });
  const verified: Candidate[] = [];
  const rejected: PipelineResult["rejected"] = [];
  for (const c of d.candidates) {
    const v = verifyCitation(toS6Citation(c.hit.citation, ctx.workspace.id), { user: ctx.user, workspace: ctx.workspace, index: ctx.index, documentRef: (w, doc) => refOf(ctx, w, doc) });
    if (v.valid) verified.push(c);
    else rejected.push({ hit: c.hit, reason: v.reason });
  }
  const r = decide(req.query, d, verified, d.evidence, { workspaceId: ctx.workspace.id, title: req.title, minCoverage: req.minCoverage, topK: req.topK });
  const behind = new Map(verified.map((c) => [c.hit, c.passage]));
  return { hits: r.hits, rejected, truncated: r.truncated, skippedDocuments: r.skippedDocuments, abstained: r.abstained, decision: r.decision, candidates: verified.map((c) => c.hit), passages: r.hits.map((h) => behind.get(h)!) };
}
