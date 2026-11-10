// Indexing a workspace's agreements for M3. One M3 document per agreement (template); its indexed version is the
// published one (templates.active_version_id), or the newest version while nothing is published. Text comes from
// the stored PDF, read only after its fingerprint matches, through the same extraction and passage split M2.2 uses
// (lib/pdf/extract, lib/understand/text, lib/qa/retrieve). Passages M2.2 sets aside as written to software are not
// indexed. Every statement is scoped by the workspace id passed in, which callers take from the session.
import { all, one } from "../db";
import { extractPdf, type Extracted } from "../pdf/extract";
import { getBlob } from "../storage";
import { sha256 } from "../util";
import { INVISIBLE, pageLines } from "../understand/text";
import { MAX_PAGES } from "../understand/store";
import { passages } from "../qa/retrieve";
import { appIndex } from "./db";
import { LIMITS } from "./index";
import { looksLikeInjection } from "./index/injection";
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
  const ps = passagesFromExtraction(ex, !!(JSON.parse(v.detection_json) as { addedSignaturePage?: boolean }).addedSignaturePage);
  if (!ps.length) throw new IngestError("no text layer");
  return ps;
}

/**
 * Passages of an extracted agreement, as indexed. The text is M2.2's (pageLines removes invisible characters, so
 * quotes match what the page shows). But removing them can hide an instruction from the hard gate: "previous<zero
 * width space>instructions" reads "previousinstructions". So the gate also reads the page with invisible characters
 * as spaces. On a page where that finds an instruction the plain text hides, the page is indexed from that spaced
 * reading instead: the instruction becomes its own passage, which S4 flags (never evidence, never cited, reported
 * as ignored), and the clauses next to it stay usable.
 */
export function passagesFromExtraction(ex: Extracted, addedSignaturePage: boolean): { id: string; page: number; text: string; binding: boolean }[] {
  // the signature page AgreementOS added isn't part of what the agreement says
  const keep = <T,>(pages: T[]) => pages.slice(0, addedSignaturePage && ex.pages.length > 1 ? -1 : undefined);
  const clean = passages(keep(pageLines(ex)));
  const spacedEx: Extracted = { ...ex, pages: ex.pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, str: i.str.replace(INVISIBLE, " ") })) })) };
  const spaced = passages(keep(pageLines(spacedEx)));
  const gate = (t: string) => looksLikeInjection(t);
  const cleanHit = new Set([...clean.passages, ...clean.excluded].filter((p) => gate(p.text)).map((p) => p.text.replace(/\s+/g, "")));
  // pages where the spaced reading finds an instruction the clean text doesn't show as one
  const hidden = new Set([...spaced.passages, ...spaced.excluded].filter((p) => gate(p.text) && !cleanHit.has(p.text.replace(/\s+/g, ""))).map((p) => p.page));
  const out = [
    ...clean.passages.filter((p) => !hidden.has(p.page)),
    ...spaced.passages.filter((p) => hidden.has(p.page)),
    ...spaced.excluded.filter((p) => hidden.has(p.page) && gate(p.text)),
  ].sort((a, b) => a.page - b.page);
  return out.slice(0, LIMITS.passagesPerVersion).map((p) => ({ id: p.id, page: p.page, text: p.text.slice(0, LIMITS.passageChars), binding: true }));
}

/** Put one agreement into the index at its current version (an active put supersedes the previous version). */
export async function indexAgreement(wsId: string, doc: AgreementDoc, index: SqliteIndex = appIndex()): Promise<void> {
  const ps = await versionPassages(wsId, doc.versionId);
  index.put({ workspaceId: wsId, documentId: doc.templateId, versionId: doc.versionId, status: "active", binding: true, passages: ps });
  // a version the index already holds as superseded (e.g. v1 republished after v2) stays superseded on put: S4 only
  // promotes through supersede(), which also demotes whatever else is active
  index.supersede(wsId, doc.templateId, doc.versionId);
  const active = one<{ version_id: string }>("SELECT version_id FROM m3_versions WHERE workspace_id = ? AND document_id = ? AND status = 'active'", wsId, doc.templateId);
  if (active?.version_id !== doc.versionId) throw new IngestError("the index didn't take the current version");
}

// one indexing run per workspace at a time in this process (the button, re-index and the owner's publish hook)
const chains = new Map<string, Promise<unknown>>();
function serial<T>(wsId: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(wsId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(wsId, next);
  void next.finally(() => {
    if (chains.get(wsId) === next) chains.delete(wsId);
  }).catch(() => undefined);
  return next;
}

/**
 * Bring the workspace's index up to date: index agreements whose current version isn't indexed yet (or all of them
 * with `force`), and remove agreements that were archived or deleted. Failures are reported per agreement.
 */
export function indexWorkspace(wsId: string, o: { force?: boolean; templateId?: string } = {}): Promise<IndexOutcome> {
  return serial(wsId, () => indexWorkspaceNow(wsId, o));
}

async function indexWorkspaceNow(wsId: string, o: { force?: boolean; templateId?: string }): Promise<IndexOutcome> {
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
