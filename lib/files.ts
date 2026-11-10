import crypto from "node:crypto";
import { all, one, run, tx } from "./db";
import { audit, EVENT_TEXT, fileEvents } from "./audit";
import { emailMode, layout, sendEmail } from "./email";
import { emit } from "./webhooks";
import { getBlob, putBlob } from "./storage";
import { seal, unseal } from "./secret";
import { appUrl } from "./paths";
import { addDays, escapeHtml, id, now, safeEqual, sha256, token } from "./util";
import { appendCertificate, stampFields, type StampValue } from "./pdf/stamp";
import { printForPdf, printProblem, showChars } from "./pdf/printable";
import { printProblemFor } from "./sign-fields";
import type { Field, PageSize } from "./fields";
import type { FileRow, Template, TemplateVersion, Workspace } from "./types";

import { AppError } from "./errors";
import { assertCanSendTo } from "./emailverify";
import { BRAND } from "./brand";
export { AppError };

export type Ctx = { ip?: string; ua?: string };
export type Actor = { kind: "user" | "api" | "inbound" | "system" | "client"; label: string; userId?: string };

export function getWorkspace(wsId: string): Workspace {
  const ws = one<Workspace>("SELECT * FROM workspaces WHERE id = ?", wsId);
  if (!ws) throw new AppError("Workspace not found", 404);
  return ws;
}

export function getFile(wsId: string, fileId: string): FileRow {
  const f = one<FileRow>("SELECT * FROM files WHERE id = ? AND workspace_id = ?", fileId, wsId);
  if (!f) throw new AppError("File not found", 404);
  return f;
}

export function getVersion(versionId: string): TemplateVersion {
  const v = one<TemplateVersion>("SELECT * FROM template_versions WHERE id = ?", versionId);
  if (!v) throw new AppError("Agreement version not found", 404);
  return v;
}

/**
 * A stored PDF, re-hashed against the fingerprint recorded when it was stored, before it is signed, sealed or
 * served. If the bytes on disk changed, they aren't used: the attempt is audited and refused (409).
 */
export async function verifiedBlob(rel: string, expected: string, at: { wsId: string; fileId: string | null; document: string; actor: string; ctx?: Ctx }): Promise<Buffer> {
  const buf = await getBlob(rel);
  const actual = sha256(buf);
  if (actual !== expected) {
    audit(at.wsId, at.fileId, "document.fingerprint_mismatch", at.actor, at.ctx ?? {}, { document: at.document, expected_sha256: expected, actual_sha256: actual });
    throw new AppError("The stored PDF doesn't match its recorded fingerprint, so it wasn't used.", 409);
  }
  return buf;
}

export function versionFields(v: TemplateVersion): Field[] {
  return JSON.parse(v.fields_json) as Field[];
}

export function versionPages(v: TemplateVersion): PageSize[] {
  return JSON.parse(v.pages_json) as PageSize[];
}

export function resolveTemplate(wsId: string, templateId?: string | null): { template: Template; version: TemplateVersion } {
  const t = templateId
    ? one<Template>("SELECT * FROM templates WHERE id = ? AND workspace_id = ? AND archived = 0", templateId, wsId)
    : (one<Template>("SELECT * FROM templates WHERE workspace_id = ? AND archived = 0 AND active_version_id IS NOT NULL ORDER BY is_default DESC, created_at DESC LIMIT 1", wsId) ?? undefined);
  if (!t) throw new AppError(templateId ? "Agreement not found" : "Upload and publish an agreement first.", templateId ? 404 : 409);
  if (!t.active_version_id) throw new AppError(`"${t.name}" has no published version yet. Review its fields and publish it first.`, 409);
  return { template: t, version: getVersion(t.active_version_id) };
}

export function signingLink(f: FileRow): string | null {
  if (!f.token_enc) return null;
  try {
    return `${appUrl()}/s/${unseal(f.token_enc)}`;
  } catch {
    console.error("[signingLink] can't unseal token (APP_SECRET changed?)", f.id);
    return null;
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: process.env.APP_TZ || "America/New_York" });
}

export type NewFile = {
  templateId?: string | null;
  clientName: string;
  clientEmail: string;
  clientCompany?: string | null;
  ref?: string | null;
  title?: string | null;
  prefill?: Record<string, string>;
};

const DAILY_FILE_CAP = Number(process.env.DAILY_FILE_CAP || 300);

export async function createFile(ws: Workspace, input: NewFile, actor: Actor, ctx: Ctx, send = true): Promise<FileRow> {
  const today = one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE workspace_id = ? AND created_at > ?", ws.id, new Date(Date.now() - 86400_000).toISOString())?.n ?? 0;
  if (today >= DAILY_FILE_CAP) throw new AppError(`This workspace has opened ${DAILY_FILE_CAP} files in the last 24 hours, the current limit. Contact support to raise it.`, 429);
  if (send) assertCanSendTo(ws.id, input.clientEmail);
  const { template, version } = resolveTemplate(ws.id, input.templateId);
  assertPrintableFile(input, ws, template, version);
  if (input.ref && one("SELECT 1 FROM files WHERE workspace_id = ? AND ref = ? AND status NOT IN ('voided','declined')", ws.id, input.ref)) {
    throw new AppError(`A file with reference "${input.ref}" already exists.`, 409);
  }
  const fid = id("file_");
  const tok = token(24);
  run(
    `INSERT INTO files (id, workspace_id, template_version_id, ref, title, client_name, client_email, client_company, prefill_json, status, token_hash, token_enc, source, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fid,
    ws.id,
    version.id,
    input.ref || null,
    input.title || `${template.name}: ${input.clientName}`,
    input.clientName,
    input.clientEmail.toLowerCase(),
    input.clientCompany || null,
    JSON.stringify(input.prefill ?? {}),
    "draft",
    sha256(tok),
    seal(tok),
    actor.kind,
    actor.userId ?? null,
    now(),
  );
  audit(ws.id, fid, "file.created", actor.label, ctx, { template: template.name, version: version.version, source: actor.kind });
  const f = getFile(ws.id, fid);
  emit(ws.id, "file.created", fileJson(f));
  if (send) return sendFile(f, ws, "invite", actor, ctx);
  return f;
}

// What a file puts onto the signed PDF (stamps and certificate) must print exactly: refuse it here, before the
// file exists, rather than at signing (lib/pdf/printable.ts). Only the prefill values a field stamps are checked.
// The firm's names and the agreement name (both on the certificate) are checked too, so a file never reaches the
// client only to be impossible to countersign.
function assertPrintableFile(input: NewFile, ws: Workspace, template: Template, version: TemplateVersion) {
  const custom = new Set(versionFields(version).flatMap((fl) => (fl.role === "prefill" && fl.type !== "checkbox" && fl.prefillKey?.startsWith("custom.") ? [fl.prefillKey.slice(7)] : [])));
  const checks: [string | null | undefined, string, string][] = [
    [input.clientName, "The client name", "name"],
    [input.clientEmail, "The client email", "email"],
    [input.clientCompany, "The client company", "name"],
    [input.ref, "The file reference", "reference"],
    [input.title, "The file title", "title"],
    [template.name, `The agreement name "${template.name}"`, "name"],
    [ws.legal_name, "Your firm's legal name (in Settings)", "name"],
    [ws.countersigner_name, "The countersigner's name (in Settings)", "name"],
    [ws.countersigner_title, "The countersigner's title (in Settings)", "title"],
    [ws.countersigner_email, "The countersigner's email (in Settings)", "email"],
    ...Object.entries(input.prefill ?? {}).filter(([k]) => custom.has(k.replace(/^custom\./, ""))).map(([k, v]): [string, string, string] => [v, `The value for "${k}"`, "value"]),
  ];
  for (const [v, subject, noun] of checks) {
    const problem = printProblem(v, subject, noun);
    if (problem) throw new AppError(problem, 422);
  }
}

function templateName(f: FileRow) {
  return one<{ name: string }>("SELECT t.name FROM templates t JOIN template_versions v ON v.template_id = t.id WHERE v.id = ?", f.template_version_id)?.name ?? "agreement";
}

// Every name the firm's stamps and the certificate of completion print, from one place: countersignOnce prints
// only these, and completeClientSigning checks them (sealProblem) before the client signs, so a file is never
// signed by the client only to be impossible to countersign.
type SealNames = {
  clientName: string;
  clientEmail: string;
  title: string;
  ref: string | null;
  agreement: string;
  legalName: string;
  signerName: string;
  signerTitle: string | null;
  signerEmail: string | null;
};
const SEAL_LABELS: Record<keyof SealNames, string> = {
  clientName: "the client name",
  clientEmail: "the client email",
  title: "the file title",
  ref: "the file reference",
  agreement: "the agreement name",
  legalName: "the firm's legal name",
  signerName: "the countersigner's name",
  signerTitle: "the countersigner's title",
  signerEmail: "the countersigner's email",
};
function sealNames(f: FileRow, ws: Workspace): SealNames {
  return {
    clientName: f.client_name,
    clientEmail: f.client_email,
    title: f.title,
    ref: f.ref,
    agreement: templateName(f),
    legalName: ws.legal_name,
    signerName: ws.countersigner_name || ws.legal_name,
    signerTitle: ws.countersigner_title,
    signerEmail: ws.countersigner_email,
  };
}
/** The first name the certificate (or the firm's stamps) can't print exactly, with its characters; null when none. */
function sealProblem(n: SealNames, events: { actor: string }[]): { what: string; chars: string } | null {
  for (const k of Object.keys(SEAL_LABELS) as (keyof SealNames)[]) {
    const bad = n[k] ? printForPdf(n[k]).bad : [];
    if (bad.length) return { what: SEAL_LABELS[k], chars: showChars(bad) };
  }
  for (const e of events) {
    const bad = printForPdf(e.actor).bad;
    if (bad.length) return { what: `a name in the file's history ("${e.actor}")`, chars: showChars(bad) };
  }
  return null;
}

export async function sendFile(f: FileRow, ws: Workspace, kind: "invite" | "resend" | "reminder", actor: Actor, ctx: Ctx): Promise<FileRow> {
  if (["completed", "voided", "signed"].includes(f.status)) throw new AppError(`This file is ${f.status}; it can't be sent again.`, 409);
  if (f.status === "declined" && kind !== "resend") throw new AppError("This file was declined. Use Send again.", 409);
  assertCanSendTo(ws.id, f.client_email);
  // the link first (the token never changes): if it can't be built, e.g. APP_SECRET missing or changed, nothing is
  // marked sent and nothing is emailed
  const link = signingLink(f);
  if (!link) throw new AppError("This file's signing link can't be built, so nothing was sent.", 500);
  const t = now();
  if (f.status === "draft" || f.status === "expired" || f.status === "declined") {
    // (re)starting the clock: reminders count from now
    run("UPDATE files SET status = 'sent', sent_at = ?, reminders_sent = 0, expires_at = ?, declined_at = NULL, consent_at = NULL WHERE id = ?", t, addDays(t, ws.expiry_days), f.id);
  } else if (kind === "resend") {
    run("UPDATE files SET expires_at = ? WHERE id = ?", addDays(t, ws.expiry_days), f.id);
  }
  if (kind === "reminder") run("UPDATE files SET reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?", t, f.id);
  const file = getFile(ws.id, f.id);
  const name = templateName(file);
  const first = escapeHtml(file.client_name.split(" ")[0] || file.client_name);
  const onFile = file.title.startsWith(name) ? "" : ` on <b>${escapeHtml(file.title)}</b>`;
  const subject =
    kind === "reminder" ? `Reminder: your ${name} from ${ws.name} is waiting for your signature` : `${ws.name}: please review and sign your ${name}`;
  const body =
    kind === "reminder"
      ? `Hi ${first},<br><br>This is a reminder that <b>${escapeHtml(ws.name)}</b> is waiting on your signature on the <b>${escapeHtml(name)}</b> before work can begin${onFile}.`
      : `Hi ${first},<br><br><b>${escapeHtml(ws.name)}</b> needs your signature on the <b>${escapeHtml(name)}</b> before work can begin${onFile}. It takes about two minutes, and you can sign on your phone. No account needed.`;
  const r = await sendEmail({
    workspaceId: ws.id,
    fileId: file.id,
    kind,
    to: file.client_email,
    redact: [link],
    subject,
    fromName: ws.sender_name,
    replyTo: ws.reply_to,
    html: layout({
      brand: ws.brand_color,
      firm: ws.name,
      heading: kind === "reminder" ? "Your agreement is still waiting" : "Your agreement is ready to sign",
      body: body + (file.expires_at ? `<br><br><span style="color:#5b6474;font-size:13px">This link expires on ${formatDate(file.expires_at)}.</span>` : ""),
      cta: { href: link, label: "Review and sign" },
    }),
  });
  const emailStatus = r.delivered ? "sent" : r.error ? "failed" : "logged";
  run("UPDATE files SET email_status = ?, email_error = ? WHERE id = ?", emailStatus, r.error ?? null, file.id);
  const type = kind === "invite" ? "file.sent" : kind === "resend" ? "file.resent" : "file.reminded";
  if (emailStatus === "failed") {
    // the link still works (the firm can copy it), but nobody should think the client was emailed
    audit(ws.id, file.id, "file.email_failed", actor.label, ctx, { to: file.client_email, kind, error: r.error });
  } else {
    audit(ws.id, file.id, type, actor.label, ctx, { to: file.client_email, delivery: emailStatus });
    if (kind === "invite") emit(ws.id, "file.sent", fileJson(file));
  }
  return getFile(ws.id, file.id);
}

export function prefillValues(f: FileRow, ws: Workspace, fields: Field[]): Map<string, StampValue> {
  const custom = JSON.parse(f.prefill_json || "{}") as Record<string, string>;
  const m = new Map<string, StampValue>();
  for (const fl of fields) {
    if (fl.role !== "prefill" || !fl.prefillKey) continue;
    const k = fl.prefillKey;
    let v = "";
    if (k === "client.name") v = f.client_name;
    else if (k === "client.email") v = f.client_email;
    else if (k === "client.company") v = f.client_company || "";
    else if (k === "file.ref") v = f.ref || "";
    else if (k === "file.date") v = formatDate(f.sent_at || f.created_at);
    else if (k === "firm.legal_name") v = ws.legal_name;
    else if (k.startsWith("custom.")) v = custom[k.slice(7)] ?? custom[k] ?? "";
    if (fl.type === "checkbox") m.set(fl.id, { kind: "check", on: /^(1|true|yes|x)$/i.test(v) });
    else if (v) m.set(fl.id, { kind: "text", text: v });
  }
  return m;
}

// A signing link keeps working for the client's own copy for this long after completion, then closes.
// (The copy is also emailed; the firm can always download it from the app.)
export const COPY_LINK_DAYS = 30;
export function copyLinkClosed(f: FileRow) {
  return f.status === "completed" && !!f.completed_at && Date.now() > new Date(f.completed_at).getTime() + COPY_LINK_DAYS * 86400_000;
}

export function loadByToken(tok: string) {
  if (!tok || tok.length > 100) return null;
  const f = one<FileRow>("SELECT * FROM files WHERE token_hash = ?", sha256(tok));
  if (!f) return null;
  const ws = getWorkspace(f.workspace_id);
  const v = getVersion(f.template_version_id);
  return { file: f, ws, version: v, fields: versionFields(v), pages: versionPages(v) };
}

export function expireIfDue(f: FileRow, ws: Workspace): FileRow {
  if ((f.status === "sent" || f.status === "viewed") && f.expires_at && f.expires_at < now()) {
    run("UPDATE files SET status = 'expired' WHERE id = ? AND status IN ('sent','viewed')", f.id);
    audit(ws.id, f.id, "file.expired", "system");
    const nf = getFile(ws.id, f.id);
    emit(ws.id, "file.expired", fileJson(nf));
    return nf;
  }
  return f;
}

export function markViewed(f: FileRow, ws: Workspace, ctx: Ctx) {
  if (f.status !== "sent") return;
  run("UPDATE files SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", now(), f.id);
  audit(ws.id, f.id, "file.viewed", f.client_email, ctx);
  emit(ws.id, "file.viewed", fileJson(getFile(ws.id, f.id)));
}

export async function sendOtp(f: FileRow, ws: Workspace, ctx: Ctx): Promise<boolean> {
  const code = String(crypto.randomInt(100000, 1000000));
  run("UPDATE files SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0 WHERE id = ?", sha256(f.id + ":" + code), new Date(Date.now() + 10 * 60_000).toISOString(), f.id);
  const r = await sendEmail({
    workspaceId: ws.id,
    fileId: f.id,
    kind: "otp",
    to: f.client_email,
    subject: `${code} is your verification code`,
    fromName: ws.sender_name,
    html: layout({
      brand: ws.brand_color,
      firm: ws.name,
      heading: "Your verification code",
      body: `Enter this code to open your agreement:<br><br><span style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</span><br><br>It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    }),
    logHtml: "<p>Verification code email (code withheld from the log).</p>",
  });
  audit(ws.id, f.id, "file.otp_sent", "system", ctx, { to: f.client_email, delivered: r.delivered });
  return r.delivered || emailMode() === "outbox";
}

export function verifyOtp(f: FileRow, ws: Workspace, code: string, ctx: Ctx): boolean {
  const expired = () => new AppError("The code has expired. Send a new one.", 400);
  if (!f.otp_hash || !f.otp_expires_at || f.otp_expires_at < now()) throw expired();
  // each try takes one of the 5 from the row itself, atomically, for this same code: `f` may be stale (loaded before
  // the request body was read), so concurrent requests can't each see the old count
  const took = run("UPDATE files SET otp_attempts = otp_attempts + 1 WHERE id = ? AND otp_hash = ? AND otp_attempts < 5", f.id, f.otp_hash);
  if (Number(took.changes) !== 1) {
    const cur = one<{ otp_hash: string | null; otp_attempts: number }>("SELECT otp_hash, otp_attempts FROM files WHERE id = ?", f.id);
    if (cur?.otp_hash === f.otp_hash && cur.otp_attempts >= 5) throw new AppError("Too many wrong codes. Send a new one.", 429);
    throw expired(); // used, or replaced by a new code, meanwhile
  }
  if (!safeEqual(sha256(f.id + ":" + code.trim()), f.otp_hash)) {
    audit(ws.id, f.id, "file.otp_failed", f.client_email, ctx);
    return false;
  }
  // single use: only the request that clears this code verifies with it
  const used = run("UPDATE files SET otp_verified_at = ?, otp_hash = NULL WHERE id = ? AND otp_hash = ?", now(), f.id, f.otp_hash);
  if (Number(used.changes) !== 1) throw expired();
  audit(ws.id, f.id, "file.otp_verified", f.client_email, ctx);
  return true;
}

const locks = new Set<string>();

export function recordConsent(f: FileRow, ws: Workspace, ctx: Ctx) {
  const u = run("UPDATE files SET consent_at = ? WHERE id = ? AND consent_at IS NULL", now(), f.id);
  if (Number(u.changes) === 1) audit(ws.id, f.id, "file.consented", f.client_email, ctx, { disclosure_version: "2026-11-05" });
}

function parsePng(dataUrl: string | undefined, what: string): Uint8Array {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  if (!m) throw new AppError(`Add your ${what} first.`);
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 600_000) throw new AppError(`Your ${what} image is too large.`);
  if (buf.length < 24 || buf.subarray(1, 4).toString("latin1") !== "PNG" || buf.subarray(12, 16).toString("latin1") !== "IHDR") throw new AppError(`Your ${what} image is invalid.`);
  const w = buf.readUInt32BE(16),
    h = buf.readUInt32BE(20);
  if (!w || !h || w > 4000 || h > 2000) throw new AppError(`Your ${what} image is too large.`);
  return new Uint8Array(buf);
}

export type SignInput = {
  consent: boolean;
  values: Record<string, string | boolean>;
  signature?: string;
  initials?: string;
  method: "drawn" | "typed";
};

export async function completeClientSigning(tok: string, input: SignInput, ctx: Ctx): Promise<FileRow> {
  const loaded = loadByToken(tok);
  if (!loaded) throw new AppError("This signing link isn't valid.", 404);
  const { ws, version, fields } = loaded;
  const f = expireIfDue(loaded.file, ws);
  if (f.status === "expired") throw new AppError("This signing link has expired. Ask the sender for a new one.", 410);
  if (f.status !== "sent" && f.status !== "viewed") throw new AppError("This agreement has already been completed or is no longer available.", 409);
  if (!input.consent) throw new AppError("You need to agree to sign electronically.");
  // the certificate is only printed at countersign: refuse now, before anything is written, if it couldn't be
  const sealBad = sealProblem(sealNames(f, ws), [...fileEvents(f.id), { actor: f.client_email }]);
  if (sealBad) throw new AppError(`This document can't be signed yet: the sender needs to correct ${sealBad.what} (it has ${sealBad.chars}, which the signed PDF can't print exactly). Nothing was signed.`, 422);
  if (locks.has(f.id)) throw new AppError("Already signing. Please wait.", 409);
  locks.add(f.id);
  try {
    recordConsent(f, ws, ctx);
    const mine = fields.filter((x) => x.role === "client");
    const values = prefillValues(f, ws, fields);
    const signedAt = now();
    let sigPng: Uint8Array | undefined;
    let iniPng: Uint8Array | undefined;
    const stored: Record<string, string | boolean> = {};
    for (const fl of mine) {
      const raw = input.values[fl.id];
      if (fl.type === "signature") {
        sigPng ??= parsePng(input.signature, "signature");
        values.set(fl.id, { kind: "image", png: sigPng });
      } else if (fl.type === "initials") {
        iniPng ??= parsePng(input.initials, "initials");
        values.set(fl.id, { kind: "image", png: iniPng });
      } else if (fl.type === "date") {
        values.set(fl.id, { kind: "text", text: formatDate(signedAt) });
      } else if (fl.type === "checkbox") {
        const on = raw === true || raw === "true";
        if (fl.required && !on) throw new AppError(`Tick "${fl.label}" to continue.`);
        values.set(fl.id, { kind: "check", on });
        stored[fl.id] = on;
      } else {
        let v = typeof raw === "string" ? raw.trim().slice(0, 300) : "";
        if (!v && raw === undefined) {
          if (fl.type === "name") v = f.client_name;
          else if (fl.type === "email") v = f.client_email;
          else if (fl.type === "company") v = f.client_company ?? "";
        }
        if (fl.required && !v) throw new AppError(`Fill in "${fl.label}".`);
        if (fl.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new AppError(`"${fl.label}" needs a valid email.`);
        const unprintable = v ? printProblemFor(fl, v) : null;
        if (unprintable) throw new AppError(unprintable, 422);
        if (v) values.set(fl.id, { kind: "text", text: v });
        stored[fl.id] = v;
      }
    }
    if (!sigPng) sigPng = input.signature ? parsePng(input.signature, "signature") : undefined;
    const original = await verifiedBlob(version.pdf_path, version.sha256, { wsId: ws.id, fileId: f.id, document: "original", actor: f.client_email, ctx });
    const signedPdf = Buffer.from(await stampFields(original, fields.filter((x) => x.role !== "firm"), values, "client"));
    const hash = sha256(signedPdf);
    const docPath = await putBlob(`ws/${ws.id}/files/${f.id}/client-signed.pdf`, signedPdf);
    if (sigPng) await putBlob(`ws/${ws.id}/files/${f.id}/client-signature.png`, sigPng);
    const ok = tx(() => {
      const upd = run(
        "UPDATE files SET status = 'signed', client_signed_at = ?, client_values_json = ? WHERE id = ? AND status IN ('sent','viewed')",
        signedAt,
        JSON.stringify(stored),
        f.id,
      );
      if (Number(upd.changes) !== 1) return false;
      run("INSERT INTO documents (id, workspace_id, file_id, kind, path, sha256, created_at) VALUES (?,?,?,?,?,?,?)", id("doc_"), ws.id, f.id, "client_signed", docPath, hash, now());
      return true;
    });
    if (!ok) throw new AppError("This agreement was already signed or is no longer available.", 409);
    audit(ws.id, f.id, "file.signed", f.client_email, ctx, { sha256: hash, method: input.method, original_sha256: version.sha256 });
    const signed = getFile(ws.id, f.id);
    emit(ws.id, "file.signed", fileJson(signed));
    if (ws.auto_countersign) {
      try {
        return await countersign(signed, ws, { kind: "system", label: "auto-countersign" }, {});
      } catch (e) {
        // the client's signature is safe; tell the firm to countersign by hand
        console.error("[auto-countersign]", f.id, e);
      }
    }
    await notifyFirm(ws, signed, "ready");
    return getFile(ws.id, f.id);
  } finally {
    locks.delete(f.id);
  }
}

export async function countersign(f0: FileRow, ws: Workspace, actor: Actor, ctx: Ctx): Promise<FileRow> {
  const key = `cs:${f0.id}`;
  if (locks.has(key)) throw new AppError("This file is already being countersigned.", 409);
  locks.add(key);
  try {
    return await countersignOnce(getFile(ws.id, f0.id), ws, actor, ctx);
  } finally {
    locks.delete(key);
  }
}

async function countersignOnce(f: FileRow, ws: Workspace, actor: Actor, ctx: Ctx): Promise<FileRow> {
  if (f.status !== "signed") throw new AppError("Only files signed by the client can be countersigned.", 409);
  const version = getVersion(f.template_version_id);
  const fields = versionFields(version);
  const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'client_signed'", f.id);
  if (!doc) throw new AppError("Client-signed document missing.", 500);
  const t = now();
  const n = sealNames(f, ws);
  // the countersign event is written to the log only once the sealed file exists (below)
  const events = [...fileEvents(f.id), { seq: 0, file_id: f.id, type: "file.countersigned", actor: actor.label, ip: ctx.ip ?? null, user_agent: null, data_json: "{}", created_at: t }];
  const sealBad = sealProblem(n, events);
  if (sealBad) throw new AppError(`This file can't be countersigned: ${sealBad.what} has a character the signed PDF can't print exactly (${sealBad.chars}), and it is never printed altered. Nothing was changed.`, 422);
  const signerName = n.signerName;
  const values = new Map<string, StampValue>();
  const sigImg = ws.countersign_image ? new Uint8Array(await getBlob(ws.countersign_image)) : null;
  for (const fl of fields.filter((x) => x.role === "firm")) {
    if (fl.type === "signature" || fl.type === "initials") {
      values.set(fl.id, sigImg ? { kind: "image", png: sigImg } : { kind: "text", text: `/s/ ${signerName}` });
    } else if (fl.type === "name") values.set(fl.id, { kind: "text", text: signerName });
    else if (fl.type === "title" && n.signerTitle) values.set(fl.id, { kind: "text", text: n.signerTitle });
    else if (fl.type === "date") values.set(fl.id, { kind: "text", text: formatDate(t) });
    else if (fl.type === "company") values.set(fl.id, { kind: "text", text: n.legalName });
    else if (fl.type === "email" && n.signerEmail) values.set(fl.id, { kind: "text", text: n.signerEmail });
    else if (fl.type === "checkbox") values.set(fl.id, { kind: "check", on: true });
  }
  const base = await verifiedBlob(doc.path, doc.sha256, { wsId: ws.id, fileId: f.id, document: "client_signed", actor: actor.label, ctx });
  const stamped = await stampFields(base, fields.filter((x) => x.role === "firm"), values);
  const method = actor.kind === "system" ? "adopted signature, applied automatically" : "applied by " + actor.label;

  const signedEv = events.find((e) => e.type === "file.signed");
  const final = await appendCertificate(stamped, {
    envelopeId: f.id,
    documentName: n.title.startsWith(n.agreement) ? `${n.agreement} (version ${version.version}), client ${n.clientName}${n.ref ? `, file ${n.ref}` : ""}` : `${n.agreement} (version ${version.version}): ${n.title}`,
    firmName: n.legalName,
    originalSha256: version.sha256,
    clientSignedSha256: doc.sha256,
    parties: [
      {
        role: "Client",
        name: n.clientName,
        email: n.clientEmail,
        signedAt: (f.client_signed_at ?? "").replace("T", " ").slice(0, 19) + " UTC",
        ip: signedEv?.ip ?? undefined,
        method: `${JSON.parse(signedEv?.data_json ?? "{}").method ?? "electronic"} signature, emailed link${ws.require_otp ? " + email code" : ""}`,
      },
      {
        role: `Countersigned for ${n.legalName}`,
        name: signerName,
        email: n.signerEmail || "-",
        signedAt: t.replace("T", " ").slice(0, 19) + " UTC",
        method: actor.kind === "system" ? "adopted signature, applied automatically" : `applied by ${actor.label}`,
      },
    ],
    events: events.map((e) => ({ at: e.created_at, text: EVENT_TEXT[e.type] ?? e.type, actor: e.actor, ip: e.ip })),
    verifyUrl: `${appUrl()}/verify`,
  });
  const finalBuf = Buffer.from(final);
  const hash = sha256(finalBuf);
  const p = await putBlob(`ws/${ws.id}/files/${f.id}/final.pdf`, finalBuf);
  const claimed = tx(() => {
    const u = run("UPDATE files SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'signed'", now(), f.id);
    if (Number(u.changes) !== 1) return false;
    run("INSERT INTO documents (id, workspace_id, file_id, kind, path, sha256, created_at) VALUES (?,?,?,?,?,?,?)", id("doc_"), ws.id, f.id, "final", p, hash, now());
    audit(ws.id, f.id, "file.countersigned", actor.label, ctx, { signer: signerName, method });
    audit(ws.id, f.id, "file.completed", "system", {}, { sha256: hash });
    return true;
  });
  if (!claimed) throw new AppError("This file changed while it was being countersigned (it may have been voided).", 409);
  const done = getFile(ws.id, f.id);
  const filename = downloadName(done);
  const link = signingLink(done);
  const copy = await sendEmail({
    workspaceId: ws.id,
    fileId: f.id,
    kind: "completed",
    redact: link ? [link] : [],
    to: done.client_email,
    subject: `Signed: your ${templateName(done)} with ${ws.name}`,
    fromName: ws.sender_name,
    replyTo: ws.reply_to,
    html: layout({
      brand: ws.brand_color,
      firm: ws.name,
      heading: "All signed: here is your copy",
      body: `Thanks, ${escapeHtml(done.client_name.split(" ")[0])}. Both parties have signed. Your completed agreement is attached, and you can download it again from the link below for the next ${COPY_LINK_DAYS} days.`,
      cta: link ? { href: link, label: "Download signed copy" } : undefined,
    }),
    attachments: [{ filename, content: finalBuf }],
  });
  if (copy.delivered) run("UPDATE files SET copy_emailed_at = ? WHERE id = ?", now(), f.id);
  else if (copy.error) audit(ws.id, f.id, "file.email_failed", "system", {}, { to: done.client_email, kind: "completed", error: copy.error });
  await notifyFirm(ws, done, "completed", finalBuf);
  emit(ws.id, "file.completed", { ...fileJson(done), sha256: hash });
  return done;
}

export function downloadName(f: FileRow) {
  const base = `${f.title}`.replace(/[^A-Za-z0-9 _.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "agreement";
  return `${base} - signed.pdf`;
}

function firmRecipients(ws: Workspace, f: FileRow): string[] {
  const set = new Set<string>();
  if (ws.countersigner_email) set.add(ws.countersigner_email.toLowerCase());
  if (f.created_by) {
    // only while they're still on the team
    const u = one<{ email: string }>("SELECT u.email FROM users u JOIN members m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.id = ?", ws.id, f.created_by);
    if (u) set.add(u.email);
  }
  if (!set.size) for (const r of all<{ email: string }>("SELECT u.email FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ? AND m.role = 'owner'", ws.id)) set.add(r.email);
  return [...set];
}

async function notifyFirm(ws: Workspace, f: FileRow, what: "completed" | "ready" | "declined", pdf?: Buffer) {
  const url = `${appUrl()}/app/files/${f.id}`;
  const heading = what === "completed" ? `${f.client_name} signed. The file is cleared to start` : what === "ready" ? `${f.client_name} signed. Your countersignature is needed` : `${f.client_name} declined to sign`;
  const body =
    what === "declined"
      ? `Reason given: <i>${escapeHtml(f.decline_reason || "none")}</i>`
      : what === "completed"
        ? `The agreement for <b>${escapeHtml(f.title)}</b> is fully signed and sealed. The completed PDF with its audit certificate is attached.`
        : `Open the file to review and countersign.`;
  for (const to of firmRecipients(ws, f)) {
    await sendEmail({
      workspaceId: ws.id,
      fileId: f.id,
      kind: `firm_${what}`,
      to,
      subject: heading,
      fromName: BRAND.systemSender,
      html: layout({ brand: ws.brand_color, firm: ws.name, heading, body, cta: { href: url, label: "Open file" }, foot: `You get this because you're on this file in ${BRAND.name}.` }),
      attachments: pdf ? [{ filename: downloadName(f), content: pdf }] : undefined,
    });
  }
}

export async function declineFile(tok: string, reason: string, ctx: Ctx): Promise<FileRow> {
  const loaded = loadByToken(tok);
  if (!loaded) throw new AppError("This signing link isn't valid.", 404);
  const { ws } = loaded;
  const f = expireIfDue(loaded.file, ws);
  if (f.status !== "sent" && f.status !== "viewed") throw new AppError("This agreement can no longer be declined.", 409);
  run("UPDATE files SET status = 'declined', declined_at = ?, decline_reason = ? WHERE id = ?", now(), reason.slice(0, 1000), f.id);
  audit(ws.id, f.id, "file.declined", f.client_email, ctx, { reason: reason.slice(0, 1000) });
  const d = getFile(ws.id, f.id);
  await notifyFirm(ws, d, "declined");
  emit(ws.id, "file.declined", fileJson(d));
  return d;
}

export function voidFile(f: FileRow, ws: Workspace, actor: Actor, reason: string, ctx: Ctx): FileRow {
  if (f.status === "completed" || f.status === "voided") throw new AppError(`A ${f.status} file can't be voided.`, 409);
  if (locks.has(`cs:${f.id}`)) throw new AppError("This file is being countersigned right now. Try again in a moment.", 409);
  const u = run("UPDATE files SET status = 'voided', voided_at = ? WHERE id = ? AND status NOT IN ('completed','voided')", now(), f.id);
  if (Number(u.changes) !== 1) throw new AppError("This file can't be voided any more.", 409);
  audit(ws.id, f.id, "file.voided", actor.label, ctx, { reason: reason.slice(0, 500) });
  const v = getFile(ws.id, f.id);
  emit(ws.id, "file.voided", fileJson(v));
  return v;
}

export function finalDocument(f: FileRow) {
  return one<{ path: string; sha256: string; kind: string }>(
    "SELECT path, sha256, kind FROM documents WHERE file_id = ? ORDER BY CASE kind WHEN 'final' THEN 0 ELSE 1 END LIMIT 1",
    f.id,
  );
}

export type ReadinessCheck = { key: string; label: string; ok: boolean; required: boolean; detail?: string };

// "Ready for work" is earned, not assumed from the status: every required condition is re-checked,
// including that the sealed PDF on disk still matches the fingerprint recorded when it was sealed.
export async function readiness(f: FileRow): Promise<{ ready: boolean; checks: ReadinessCheck[] }> {
  const has = (type: string) => !!one("SELECT 1 FROM audit_events WHERE file_id = ? AND type = ? LIMIT 1", f.id, type);
  const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'final'", f.id);
  let sealed = false;
  let sealDetail = "No sealed PDF yet";
  if (doc) {
    try {
      sealed = sha256(await getBlob(doc.path)) === doc.sha256;
      sealDetail = sealed ? `SHA-256 ${doc.sha256.slice(0, 12)}… matches` : "Stored PDF doesn't match its recorded fingerprint";
    } catch {
      sealDetail = "Sealed PDF is missing from storage";
    }
  }
  const checks: ReadinessCheck[] = [
    { key: "consent", label: "Client consented to sign electronically", ok: !!f.consent_at, required: true },
    { key: "client_signed", label: "Client signed every required field", ok: !!f.client_signed_at && has("file.signed"), required: true },
    { key: "countersigned", label: "Your firm's countersignature applied", ok: has("file.countersigned"), required: true },
    { key: "sealed", label: "Final PDF sealed and intact", ok: sealed, required: true, detail: sealDetail },
    { key: "not_voided", label: "File is still active (not voided)", ok: f.status !== "voided", required: true },
    {
      key: "copy_emailed",
      label: "Client emailed their signed copy",
      ok: !!f.copy_emailed_at,
      required: false,
      detail: f.copy_emailed_at ? undefined : "Not emailed; the client can still download it from their link for 30 days",
    },
  ];
  return { ready: f.status === "completed" && checks.every((c) => !c.required || c.ok), checks };
}

export function fileJson(f: FileRow) {
  return {
    id: f.id,
    ref: f.ref,
    title: f.title,
    status: f.status,
    client: { name: f.client_name, email: f.client_email, company: f.client_company },
    prefill: JSON.parse(f.prefill_json || "{}"),
    created_at: f.created_at,
    sent_at: f.sent_at,
    viewed_at: f.viewed_at,
    signed_at: f.client_signed_at,
    completed_at: f.completed_at,
    declined_at: f.declined_at,
    decline_reason: f.decline_reason,
    expires_at: f.expires_at,
    ready_for_work: f.status === "completed",
    email: { status: f.email_status, error: f.email_error, copy_emailed_at: f.copy_emailed_at },
    signing_url: f.status === "voided" ? null : signingLink(f),
    document_url: f.status === "completed" ? `${appUrl()}/api/v1/files/${f.id}/document` : null,
    app_url: `${appUrl()}/app/files/${f.id}`,
  };
}

// Send the client their sealed copy again, byte for byte, when the first email didn't go out. Nothing is
// re-sealed or regenerated: the stored PDF is re-checked against its recorded fingerprint and sent as is.
export async function resendSignedCopy(f0: FileRow, ws: Workspace, actor: Actor, ctx: Ctx): Promise<{ file: FileRow; delivered: boolean; error?: string }> {
  const key = `copy:${f0.id}`;
  if (locks.has(key)) throw new AppError("The signed copy is being sent right now.", 409);
  locks.add(key);
  try {
    const f = getFile(ws.id, f0.id);
    if (f.status !== "completed") throw new AppError("Only completed files have a signed copy to send.", 409);
    const doc = one<{ path: string; sha256: string }>("SELECT path, sha256 FROM documents WHERE file_id = ? AND kind = 'final'", f.id);
    if (!doc) throw new AppError("This file has no sealed PDF to send.", 409);
    assertCanSendTo(ws.id, f.client_email);
    const buf = await getBlob(doc.path);
    if (sha256(buf) !== doc.sha256) throw new AppError("The stored PDF doesn't match its recorded fingerprint, so it wasn't sent.", 500);
    const link = copyLinkClosed(f) ? null : signingLink(f);
    const until = f.completed_at ? formatDate(addDays(f.completed_at, COPY_LINK_DAYS)) : null;
    const r = await sendEmail({
      workspaceId: ws.id,
      fileId: f.id,
      kind: "completed",
      redact: link ? [link] : [],
      to: f.client_email,
      subject: `Signed: your ${templateName(f)} with ${ws.name}`,
      fromName: ws.sender_name,
      replyTo: ws.reply_to,
      html: layout({
        brand: ws.brand_color,
        firm: ws.name,
        heading: "All signed: here is your copy",
        body: `Hi ${escapeHtml(f.client_name.split(" ")[0])}. Both parties have signed. Your completed agreement is attached${link && until ? `, and you can download it again from the link below until ${until}` : ""}.`,
        cta: link ? { href: link, label: "Download signed copy" } : undefined,
      }),
      attachments: [{ filename: downloadName(f), content: buf }],
    });
    if (r.delivered) run("UPDATE files SET copy_emailed_at = ? WHERE id = ?", now(), f.id);
    if (r.error) audit(ws.id, f.id, "file.email_failed", actor.label, ctx, { to: f.client_email, kind: "completed", error: r.error });
    else audit(ws.id, f.id, "file.copy_resent", actor.label, ctx, { to: f.client_email, delivery: r.delivered ? "sent" : "logged", sha256: doc.sha256 });
    return { file: getFile(ws.id, f.id), delivered: r.delivered, error: r.error };
  } finally {
    locks.delete(key);
  }
}

/** An email of this kind to this file went out (or was logged, with no provider) within the last `ms`. Failed attempts don't count. */
export function recentlySent(fileId: string, kind: string, ms: number): boolean {
  return !!one("SELECT 1 FROM emails WHERE file_id = ? AND kind = ? AND status IN ('sent','logged') AND created_at > ? LIMIT 1", fileId, kind, new Date(Date.now() - ms).toISOString());
}

/**
 * Run a send at most once per file and email kind at a time, and not again within `ms` of one that went out.
 * Two requests arriving together (two tabs, two people) used to both pass the "sent a moment ago" check before
 * either had recorded its email. Now the check runs inside a per-file, per-kind lock: the second request is
 * refused while the first is in flight, or sees the first one's email once it's recorded. The app runs as one
 * process (one Fly machine), so an in-process lock covers every request; more machines would need a lock in
 * the database instead.
 */
export async function sendOnce<T>(fileId: string, kind: string, ms: number, send: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false; reason: "in_flight" | "recent" }> {
  const key = `send:${fileId}:${kind}`;
  if (locks.has(key)) return { ran: false, reason: "in_flight" };
  locks.add(key);
  try {
    if (recentlySent(fileId, kind, ms)) return { ran: false, reason: "recent" };
    return { ran: true, value: await send() };
  } finally {
    locks.delete(key);
  }
}
