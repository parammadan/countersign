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

const squash = (t: string) => t.replace(/\s+/g, "");
// the sentence split M2.2's passages() uses (lib/qa/retrieve.ts); a passage is sentences joined by single spaces
const SENTENCE = /(?<=[.;!?])\s+(?=[A-Z0-9("“[])/;

/**
 * Passages of an extracted agreement, as indexed: M2.2's reading (pageLines removes invisible characters, so quotes
 * match what the page shows). But removing them can hide an instruction from the hard gate: "previous<zero width
 * space>instructions" reads "previousinstructions". So the gate also reads the page with invisible characters as
 * spaces. Only the sentences an instruction found that way overlaps are taken out of their passage; they're indexed
 * as a passage of their own, in the spaced form, which S4 flags (never evidence, never cited, reported as ignored).
 * Every other sentence keeps the normal reading ("Termi<soft hyphen>nation" stays "Termination"), in runs of
 * consecutive sentences, so each passage is still a verbatim run of the page.
 */
export function passagesFromExtraction(ex: Extracted, addedSignaturePage: boolean): { id: string; page: number; text: string; binding: boolean }[] {
  // the signature page AgreementOS added isn't part of what the agreement says
  const keep = <T,>(pages: T[]) => pages.slice(0, addedSignaturePage && ex.pages.length > 1 ? -1 : undefined);
  const clean = passages(keep(pageLines(ex)));
  const gate = (t: string) => looksLikeInjection(t);
  // Hidden instructions: only pages with an invisible character can read differently with them as spaces, and only
  // sentences of that reading that differ from the clean one need the gate (a word-for-word sentence is gated below).
  const hasInvisible = new RegExp(INVISIBLE.source, "u");
  const pagesWithInvisible = new Set(ex.pages.filter((p) => p.items.some((i) => hasInvisible.test(i.str))).map((p) => p.index + 1));
  const hidden = new Map<number, Map<string, string>>();
  if (pagesWithInvisible.size) {
    const spacedEx: Extracted = { ...ex, pages: ex.pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, str: i.str.replace(INVISIBLE, " ") })) })) };
    const spaced = passages(keep(pageLines(spacedEx)));
    const cleanSentences = new Set([...clean.passages, ...clean.excluded].flatMap((p) => p.text.split(SENTENCE)));
    for (const p of [...spaced.passages, ...spaced.excluded]) {
      if (!pagesWithInvisible.has(p.page)) continue;
      for (const text of p.text.split(SENTENCE)) {
        const key = squash(text);
        if (!key || cleanSentences.has(text) || hidden.get(p.page)?.has(key) || !gate(text)) continue;
        (hidden.get(p.page) ?? hidden.set(p.page, new Map()).get(p.page)!).set(key, text);
      }
    }
  }
  // On every page: a passage the gate flags as a whole is kept (S4 flags it at put). Otherwise each of its sentences
  // is gated on its own too, because start- and line-anchored patterns ("System: ...") only see a sentence that opens
  // its passage. A flagged sentence, or one holding a hidden instruction, becomes a passage of its own (in the spaced
  // form for a hidden one); the rest keep the normal reading, in runs of consecutive sentences (verbatim runs of the
  // page). One gate call per passage and per sentence: linear in the page.
  const out: { id: string; page: number; text: string; binding: boolean }[] = [];
  for (const p of clean.passages) {
    if (gate(p.text)) {
      out.push({ id: p.id, page: p.page, text: p.text, binding: true });
      continue;
    }
    const onPage = hidden.get(p.page);
    const key = onPage ? squash(p.text) : "";
    const mine = onPage ? [...onPage.keys()].filter((k) => key.includes(k)) : [];
    const sentences = p.text.split(SENTENCE);
    if (sentences.length === 1 && !mine.length) {
      out.push({ id: p.id, page: p.page, text: p.text, binding: true });
      continue;
    }
    let run: string[] = [];
    let part = 0;
    let x = 0;
    const flush = () => {
      if (run.length) out.push({ id: part++ === 0 ? p.id : `${p.id}~${part}`, page: p.page, text: run.join(" "), binding: true });
      run = [];
    };
    for (const sentence of sentences) {
      const k = squash(sentence);
      // reading invisible characters as spaces only adds sentence breaks, so a clean sentence holds the hidden one
      const hiddenKey = mine.length && k ? (onPage!.has(k) ? k : mine.find((h) => k.includes(h))) : undefined;
      if (hiddenKey !== undefined) {
        flush();
        out.push({ id: `${p.id}~x${++x}`, page: p.page, text: onPage!.get(hiddenKey)!, binding: true });
      } else if (k && gate(sentence)) {
        flush();
        out.push({ id: `${p.id}~x${++x}`, page: p.page, text: sentence, binding: true });
      } else run.push(sentence);
    }
    flush();
  }
  return out.slice(0, LIMITS.passagesPerVersion).map((p) => ({ ...p, text: p.text.slice(0, LIMITS.passageChars) }));
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

// one indexing run per workspace at a time in this process (the button, re-index and the owner's publish hook);
// on globalThis like the db and index handles, so a module reloaded by the dev server shares it
const gl = globalThis as unknown as { __m3IndexChains?: Map<string, Promise<unknown>> };
const chains = (gl.__m3IndexChains ??= new Map<string, Promise<unknown>>());
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
