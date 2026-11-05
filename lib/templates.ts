import { one, run, tx } from "./db";
import { ConvertError, toPdf } from "./convert";
import { extractPdf } from "./pdf/extract";
import { detectFields, type Detection } from "./detect";
import { appendSignaturePage } from "./pdf/stamp";
import { putBlob } from "./storage";
import { id, now, sha256 } from "./util";
import { AppError } from "./files";
import { FieldSchema, validateForPublish, type Field } from "./fields";
import type { Template, TemplateVersion, Workspace } from "./types";
import { audit } from "./audit";
import path from "node:path";

export type DetectionInfo = Detection & { addedSignaturePage: boolean; ms: number };

export async function ingestAgreement(
  ws: Workspace,
  upload: { data: Buffer; filename: string },
  opts: { templateId?: string; name?: string; actor: string },
): Promise<{ template: Template; version: TemplateVersion }> {
  const t0 = Date.now();
  let pdf: Buffer;
  try {
    pdf = await toPdf(upload.data, upload.filename);
  } catch (e) {
    if (e instanceof ConvertError) throw new AppError(e.message, 422);
    throw e;
  }
  let ex = await extractPdf(pdf);
  let det = detectFields(ex, { firmName: ws.legal_name });
  let added = false;
  if (!det.fields.some((f) => f.role === "client" && f.type === "signature")) {
    pdf = Buffer.from(await appendSignaturePage(pdf, ws.legal_name));
    ex = await extractPdf(pdf);
    const prev = det.warnings;
    det = detectFields(ex, { firmName: ws.legal_name });
    det.warnings = [
      "No client signature line was found in the agreement, so a signature page was added at the end. Move the fields if you'd rather sign somewhere else.",
      ...prev.filter((w) => !/No client signature|No signature line for your firm/.test(w)),
      ...det.warnings.filter((w) => !/No client signature/.test(w)),
    ];
    added = true;
  }
  const info: DetectionInfo = { ...det, addedSignaturePage: added, ms: Date.now() - t0 };
  const vid = id("tv_");
  const ext = (path.extname(upload.filename).toLowerCase() || ".pdf").replace(/[^.a-z]/g, "");
  const dir = `ws/${ws.id}/templates/${vid}`;
  await putBlob(`${dir}/source${ext}`, upload.data);
  await putBlob(`${dir}/agreement.pdf`, pdf);

  return tx(() => {
    let template: Template;
    if (opts.templateId) {
      const t = one<Template>("SELECT * FROM templates WHERE id = ? AND workspace_id = ?", opts.templateId, ws.id);
      if (!t) throw new AppError("Agreement not found", 404);
      template = t;
    } else {
      const tid = id("tpl_");
      const isFirst = !one("SELECT 1 FROM templates WHERE workspace_id = ? AND archived = 0", ws.id);
      const nm = (opts.name || path.parse(upload.filename).name).replace(/[_-]+/g, " ").trim().slice(0, 120) || "Client agreement";
      run("INSERT INTO templates (id, workspace_id, name, is_default, created_at) VALUES (?,?,?,?,?)", tid, ws.id, nm, isFirst ? 1 : 0, now());
      template = one<Template>("SELECT * FROM templates WHERE id = ?", tid)!;
    }
    const n = (one<{ n: number }>("SELECT COALESCE(MAX(version),0) n FROM template_versions WHERE template_id = ?", template.id)?.n ?? 0) + 1;
    run(
      `INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      vid,
      template.id,
      ws.id,
      n,
      upload.filename.slice(0, 200),
      `${dir}/source${ext}`,
      `${dir}/agreement.pdf`,
      sha256(pdf),
      JSON.stringify(ex.pages.map((p) => ({ width: round(p.width), height: round(p.height) }))),
      JSON.stringify(det.fields),
      JSON.stringify({
        warnings: info.warnings,
        textLayer: info.textLayer,
        defined: info.defined,
        addedSignaturePage: added,
        ms: info.ms,
        proposed: det.fields.length,
      }),
      "draft",
      now(),
    );
    audit(ws.id, null, "template.uploaded", opts.actor, {}, { template: template.name, version: n, fields: det.fields.length });
    return { template, version: one<TemplateVersion>("SELECT * FROM template_versions WHERE id = ?", vid)! };
  });
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

export function getTemplateVersion(wsId: string, versionId: string): { template: Template; version: TemplateVersion } {
  const version = one<TemplateVersion>("SELECT * FROM template_versions WHERE id = ? AND workspace_id = ?", versionId, wsId);
  if (!version) throw new AppError("Version not found", 404);
  const template = one<Template>("SELECT * FROM templates WHERE id = ?", version.template_id)!;
  return { template, version };
}

export function saveFields(wsId: string, versionId: string, raw: unknown): Field[] {
  const { version } = getTemplateVersion(wsId, versionId);
  if (version.status !== "draft") throw new AppError("Published versions can't be edited. Create a new version instead.", 409);
  const parsed = FieldSchema.array().max(300).safeParse(raw);
  if (!parsed.success) throw new AppError("Invalid fields: " + parsed.error.issues[0]?.message);
  run("UPDATE template_versions SET fields_json = ? WHERE id = ?", JSON.stringify(parsed.data), versionId);
  return parsed.data;
}

export function publishVersion(wsId: string, versionId: string, actor: string) {
  const { template, version } = getTemplateVersion(wsId, versionId);
  if (version.status !== "draft") throw new AppError("Already published.", 409);
  const errs = validateForPublish(JSON.parse(version.fields_json), JSON.parse(version.pages_json));
  if (errs.length) throw new AppError(errs.join(" "), 422);
  tx(() => {
    run("UPDATE template_versions SET status = 'published', published_at = ? WHERE id = ?", now(), versionId);
    run("UPDATE templates SET active_version_id = ? WHERE id = ?", versionId, template.id);
  });
  audit(wsId, null, "template.published", actor, {}, { template: template.name, version: version.version });
}

// Copy a published version's fields into a fresh draft on the same PDF (edit without re-uploading).
export function draftFromVersion(wsId: string, versionId: string, actor: string): TemplateVersion {
  const { template, version } = getTemplateVersion(wsId, versionId);
  const existing = one<TemplateVersion>("SELECT * FROM template_versions WHERE template_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1", template.id);
  if (existing) return existing;
  const n = (one<{ n: number }>("SELECT MAX(version) n FROM template_versions WHERE template_id = ?", template.id)?.n ?? 0) + 1;
  const vid = id("tv_");
  run(
    `INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at)
     SELECT ?, template_id, workspace_id, ?, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, 'draft', ? FROM template_versions WHERE id = ?`,
    vid,
    n,
    now(),
    version.id,
  );
  audit(wsId, null, "template.draft_created", actor, {}, { template: template.name, version: n });
  return one<TemplateVersion>("SELECT * FROM template_versions WHERE id = ?", vid)!;
}
