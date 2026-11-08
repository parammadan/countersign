// Running, storing and reviewing document analyses. Every query is scoped to the workspace; the agreement's
// stored PDF is read, never changed. Document text and findings are never logged: the audit trail records
// counts and labels only.
import { all, one, run } from "../db";
import { getTemplateVersion } from "../templates";
import { getBlob } from "../storage";
import { extractPdf } from "../pdf/extract";
import { documentTitle } from "../pdf/title";
import { AppError, getWorkspace } from "../files";
import { audit } from "../audit";
import { limited } from "../ratelimit";
import { FieldSchema } from "../fields";
import { id, now, sha256 } from "../util";
import { AnalyzerOutputSchema, type StoredAnalysis } from "./schema";
import { analyzeWithRules } from "./rules";
import { groundFindings } from "./evidence";
import { pageLines } from "./text";

export const RUNS_PER_HOUR = 20;
export const MAX_PAGES = 200;
export const DECISIONS = ["confirmed", "dismissed", "undo"] as const;
export type Decision = (typeof DECISIONS)[number];

export type Review = { decision: "confirmed" | "dismissed"; by: string; at: string };
export type AnalysisView = {
  id: string;
  createdAt: string;
  createdBy: string;
  result: StoredAnalysis;
  reviews: Record<string, Review>;
};

type Row = { id: string; workspace_id: string; template_version_id: string; source_sha256: string; analyzer: string; result_json: string; created_by: string; created_at: string };

export async function analyzeVersion(wsId: string, versionId: string, actor: string): Promise<string> {
  const { template, version } = getTemplateVersion(wsId, versionId);
  // every attempt counts, before any work, including ones that fail (stored runs are counted below as well,
  // so the limit survives a restart)
  if (limited(`understand:${wsId}`, RUNS_PER_HOUR, 3600_000)) throw new AppError(`This workspace has read ${RUNS_PER_HOUR} agreements in the last hour, the current limit. Try again later.`, 429);
  const pageCount = (JSON.parse(version.pages_json) as unknown[]).length;
  if (pageCount > MAX_PAGES) throw new AppError(`This agreement has more than ${MAX_PAGES} pages, more than we read.`, 422);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = one<{ n: number }>("SELECT COUNT(*) n FROM document_analyses WHERE workspace_id = ? AND created_at > ?", wsId, since)?.n ?? 0;
  if (recent >= RUNS_PER_HOUR) throw new AppError(`This workspace has read ${RUNS_PER_HOUR} agreements in the last hour, the current limit. Try again later.`, 429);
  const t0 = Date.now();
  const pdf = await getBlob(version.pdf_path);
  // the original is only read; if it isn't the file that was uploaded, don't describe it
  if (sha256(pdf) !== version.sha256) throw new AppError("The stored agreement doesn't match its fingerprint, so it wasn't read.", 409);
  let ex: Awaited<ReturnType<typeof extractPdf>>;
  try {
    ex = await extractPdf(new Uint8Array(pdf));
  } catch {
    throw new AppError("We couldn't read the text in this agreement.", 422);
  }
  if (ex.pages.length > MAX_PAGES) throw new AppError(`This agreement has more than ${MAX_PAGES} pages, more than we read.`, 422);
  const detection = JSON.parse(version.detection_json) as { addedSignaturePage?: boolean };
  // the signature page AgreementOS appended isn't part of what the agreement says
  const pages = pageLines(ex).slice(0, detection.addedSignaturePage && ex.pages.length > 1 ? -1 : undefined);
  const fields = FieldSchema.array().catch([]).parse(JSON.parse(version.fields_json));
  const out = AnalyzerOutputSchema.parse(
    analyzeWithRules({ pages, title: documentTitle(ex), fields, addedSignaturePage: !!detection.addedSignaturePage, firmName: getWorkspace(wsId).legal_name }),
  );
  const grounded = groundFindings(out.findings, pages);
  const warnings = [...grounded.warnings];
  if (ex.textChars < 80) warnings.unshift("This agreement has little or no text we can read (it may be a scan), so most points below are marked not found.");
  const result: StoredAnalysis = { schema: 1, analyzer: { kind: "rules", name: "AgreementOS reading rules v1" }, findings: grounded.findings, warnings, truncated: false, pages: pages.length, ms: Date.now() - t0 };
  const aid = id("an_");
  run(
    "INSERT INTO document_analyses (id, workspace_id, template_version_id, source_sha256, analyzer, result_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    aid,
    wsId,
    version.id,
    version.sha256,
    "rules",
    JSON.stringify(result),
    actor,
    now(),
  );
  audit(wsId, null, "agreement.analyzed", actor, {}, { template: template.name, version: version.version, findings: grounded.findings.length });
  return aid;
}

export function latestAnalysis(wsId: string, versionId: string): AnalysisView | null {
  getTemplateVersion(wsId, versionId); // 404 for another workspace's version
  const row = one<Row>("SELECT * FROM document_analyses WHERE workspace_id = ? AND template_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", wsId, versionId);
  if (!row) return null;
  const reviews: Record<string, Review> = {};
  for (const r of all<{ finding_id: string; decision: Review["decision"]; reviewed_by: string; reviewed_at: string }>(
    "SELECT finding_id, decision, reviewed_by, reviewed_at FROM finding_reviews WHERE analysis_id = ? AND workspace_id = ?",
    row.id,
    wsId,
  ))
    reviews[r.finding_id] = { decision: r.decision, by: r.reviewed_by, at: r.reviewed_at };
  return { id: row.id, createdAt: row.created_at, createdBy: row.created_by, result: JSON.parse(row.result_json) as StoredAnalysis, reviews };
}

/** A person's decision on one suggestion. Confirmed findings are the verified facts; nothing else changes. */
export function reviewFinding(wsId: string, analysisId: string, findingId: string, decision: Decision, actor: string): { versionId: string } {
  const row = one<Row>("SELECT * FROM document_analyses WHERE id = ? AND workspace_id = ?", analysisId, wsId);
  if (!row) throw new AppError("Analysis not found", 404);
  const latest = one<{ id: string }>("SELECT id FROM document_analyses WHERE workspace_id = ? AND template_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", wsId, row.template_version_id);
  if (latest?.id !== row.id) throw new AppError("This agreement was read again since you opened the page. Review the new results.", 409);
  const f = (JSON.parse(row.result_json) as StoredAnalysis).findings.find((x) => x.id === findingId);
  if (!f) throw new AppError("Finding not found", 404);
  if (!(DECISIONS as readonly string[]).includes(decision)) throw new AppError("Unknown decision.");
  if (decision === "undo") run("DELETE FROM finding_reviews WHERE analysis_id = ? AND finding_id = ? AND workspace_id = ?", analysisId, findingId, wsId);
  else
    run(
      `INSERT INTO finding_reviews (analysis_id, workspace_id, finding_id, decision, reviewed_by, reviewed_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(analysis_id, finding_id) DO UPDATE SET decision = excluded.decision, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
      analysisId,
      wsId,
      findingId,
      decision,
      actor,
      now(),
    );
  audit(wsId, null, "agreement.finding_reviewed", actor, {}, { category: f.category, finding: f.id, decision }); // no labels: a model's could quote the document
  return { versionId: row.template_version_id };
}
