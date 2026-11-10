// Indexing a workspace's agreements for M3. One M3 document per agreement (template); its indexed version is the
// published one (templates.active_version_id), or the newest version while nothing is published. Text comes from
// the stored PDF, read only after its fingerprint matches, through the same extraction and passage split M2.2 uses
// (lib/pdf/extract, lib/understand/text, lib/qa/retrieve). Passages M2.2 sets aside as written to software are not
// indexed. Every statement is scoped by the workspace id passed in, which callers take from the session.
import { all, one } from "../db";
import { extractPdf } from "../pdf/extract";
import { getBlob } from "../storage";
import { sha256 } from "../util";
import { pageLines } from "../understand/text";
import { MAX_PAGES } from "../understand/store";
import { passages } from "../qa/retrieve";
import { appIndex } from "./db";
import { LIMITS } from "./index";
import type { SqliteIndex } from "./index/types";

export type AgreementDoc = { templateId: string; name: string; versionId: string; version: number; sourceName: string; status: string };
export type IndexOutcome = { indexed: number; unchanged: number; removed: number; failed: { name: string; reason: string }[] };

type VersionRow = { id: string; template_id: string; version: number; source_name: string; pdf_path: string; sha256: string; pages_json: string; detection_json: string; status: string };

/** The agreements of a workspace that M3 should hold, with the version each one is indexed at. */
export function workspaceAgreements(wsId: string): AgreementDoc[] {
  return all<{ id: string; name: string; active_version_id: string | null }>(
    "SELECT id, name, active_version_id FROM templates WHERE workspace_id = ? AND archived = 0 ORDER BY created_at, id",
    wsId,
  ).flatMap((t) => {
    const v =
      (t.active_version_id ? one<VersionRow>("SELECT * FROM template_versions WHERE id = ? AND workspace_id = ?", t.active_version_id, wsId) : undefined) ??
      one<VersionRow>("SELECT * FROM template_versions WHERE template_id = ? AND workspace_id = ? ORDER BY version DESC LIMIT 1", t.id, wsId);
    return v ? [{ templateId: t.id, name: t.name, versionId: v.id, version: v.version, sourceName: v.source_name, status: v.status }] : [];
  });
}

/** Which agreement version is active in the index for each agreement of the workspace. */
export function indexedVersions(wsId: string): Map<string, { versionId: string; indexedAt: string }> {
  appIndex();
  return new Map(
    all<{ document_id: string; version_id: string; created_at: string }>(
      "SELECT document_id, version_id, created_at FROM m3_versions WHERE workspace_id = ? AND status = 'active'",
      wsId,
    ).map((r) => [r.document_id, { versionId: r.version_id, indexedAt: r.created_at }]),
  );
}

class IngestError extends Error {}

/** The passages of one stored agreement version, read from its PDF. Throws IngestError with a fixed message. */
export async function versionPassages(wsId: string, versionId: string): Promise<{ id: string; page: number; text: string; binding: boolean }[]> {
  const v = one<VersionRow>("SELECT * FROM template_versions WHERE id = ? AND workspace_id = ?", versionId, wsId);
  if (!v) throw new IngestError("not found");
  if ((JSON.parse(v.pages_json) as unknown[]).length > MAX_PAGES) throw new IngestError(`more than ${MAX_PAGES} pages`);
  const pdf = await getBlob(v.pdf_path);
  if (sha256(pdf) !== v.sha256) throw new IngestError("the stored PDF doesn't match its fingerprint");
  let ex: Awaited<ReturnType<typeof extractPdf>>;
  try {
    ex = await extractPdf(new Uint8Array(pdf));
  } catch {
    throw new IngestError("the text couldn't be read");
  }
  // the signature page AgreementOS added isn't part of what the agreement says
  const added = (JSON.parse(v.detection_json) as { addedSignaturePage?: boolean }).addedSignaturePage;
  const pages = pageLines(ex).slice(0, added && ex.pages.length > 1 ? -1 : undefined);
  const { passages: ps } = passages(pages);
  if (!ps.length) throw new IngestError("no text layer");
  return ps.slice(0, LIMITS.passagesPerVersion).map((p) => ({ id: p.id, page: p.page, text: p.text.slice(0, LIMITS.passageChars), binding: true }));
}

/** Put one agreement into the index at its current version (an active put supersedes the previous version). */
export async function indexAgreement(wsId: string, doc: AgreementDoc, index: SqliteIndex = appIndex()): Promise<void> {
  const ps = await versionPassages(wsId, doc.versionId);
  index.put({ workspaceId: wsId, documentId: doc.templateId, versionId: doc.versionId, status: "active", binding: true, passages: ps });
}

/**
 * Bring the workspace's index up to date: index agreements whose current version isn't indexed yet (or all of them
 * with `force`), and remove agreements that were archived or deleted. Failures are reported per agreement.
 */
export async function indexWorkspace(wsId: string, o: { force?: boolean; templateId?: string } = {}): Promise<IndexOutcome> {
  const index = appIndex();
  const docs = workspaceAgreements(wsId).filter((d) => !o.templateId || d.templateId === o.templateId);
  const have = indexedVersions(wsId);
  const out: IndexOutcome = { indexed: 0, unchanged: 0, removed: 0, failed: [] };
  for (const d of docs) {
    if (!o.force && have.get(d.templateId)?.versionId === d.versionId) {
      out.unchanged++;
      continue;
    }
    try {
      await indexAgreement(wsId, d, index);
      out.indexed++;
    } catch (e) {
      // fail closed: an older version must not keep answering for an agreement whose current version can't be read
      if (have.has(d.templateId)) index.remove(wsId, d.templateId);
      out.failed.push({ name: d.name, reason: e instanceof IngestError ? e.message : "indexing failed" });
    }
  }
  if (!o.templateId) {
    const live = new Set(docs.map((d) => d.templateId));
    for (const id of have.keys()) if (!live.has(id) && index.remove(wsId, id)) out.removed++;
  }
  return out;
}
