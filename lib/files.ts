import crypto from "node:crypto";
import { all, one, run, tx } from "./db";
import { audit, EVENT_TEXT, fileEvents } from "./audit";
import { layout, sendEmail } from "./email";
import { emit } from "./webhooks";
import { getBlob, putBlob } from "./storage";
import { seal, unseal } from "./secret";
import { appUrl } from "./paths";
import { addDays, escapeHtml, id, now, sha256, token } from "./util";
import { appendCertificate, stampFields, type StampValue } from "./pdf/stamp";
import type { Field, PageSize } from "./fields";
import type { FileRow, Template, TemplateVersion, Workspace } from "./types";

import { AppError } from "./errors";
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
  return `${appUrl()}/s/${unseal(f.token_enc)}`;
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
  const { template, version } = resolveTemplate(ws.id, input.templateId);
  if (input.ref && one("SELECT 1 FROM files WHERE workspace_id = ? AND ref = ?", ws.id, input.ref)) {
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

function templateName(f: FileRow) {
  return one<{ name: string }>("SELECT t.name FROM templates t JOIN template_versions v ON v.template_id = t.id WHERE v.id = ?", f.template_version_id)?.name ?? "agreement";
}

export async function sendFile(f: FileRow, ws: Workspace, kind: "invite" | "resend" | "reminder", actor: Actor, ctx: Ctx): Promise<FileRow> {
  if (["completed", "declined", "voided", "signed"].includes(f.status)) throw new AppError(`This file is ${f.status}; it can't be sent again.`, 409);
  const t = now();
  if (f.status === "draft" || f.status === "expired") {
    // (re)starting the clock: reminders count from now
    run("UPDATE files SET status = 'sent', sent_at = ?, reminders_sent = 0, expires_at = ? WHERE id = ?", t, addDays(t, ws.expiry_days), f.id);
  } else if (kind === "resend") {
    run("UPDATE files SET expires_at = ? WHERE id = ?", addDays(t, ws.expiry_days), f.id);
  }
  if (kind === "reminder") run("UPDATE files SET reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?", t, f.id);
  const file = getFile(ws.id, f.id);
  const link = signingLink(file)!;
  const name = templateName(file);
  const first = escapeHtml(file.client_name.split(" ")[0] || file.client_name);
  const onFile = file.title.startsWith(name) ? "" : ` on <b>${escapeHtml(file.title)}</b>`;
  const subject =
    kind === "reminder" ? `Reminder: your ${name} from ${ws.name} is waiting for your signature` : `${ws.name}: please review and sign your ${name}`;
  const body =
    kind === "reminder"
      ? `Hi ${first},<br><br>This is a reminder that <b>${escapeHtml(ws.name)}</b> is waiting on your signature on the <b>${escapeHtml(name)}</b> before work can begin${onFile}.`
      : `Hi ${first},<br><br><b>${escapeHtml(ws.name)}</b> needs your signature on the <b>${escapeHtml(name)}</b> before work can begin${onFile}. It takes about two minutes, and you can sign on your phone. No account needed.`;
  await sendEmail({
    workspaceId: ws.id,
    fileId: file.id,
    kind,
    to: file.client_email,
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
  const type = kind === "invite" ? "file.sent" : kind === "resend" ? "file.resent" : "file.reminded";
  audit(ws.id, file.id, type, actor.label, ctx, { to: file.client_email });
  if (kind === "invite") emit(ws.id, "file.sent", fileJson(file));
  return file;
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

export async function sendOtp(f: FileRow, ws: Workspace, ctx: Ctx) {
  const code = String(crypto.randomInt(100000, 1000000));
  run("UPDATE files SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0 WHERE id = ?", sha256(f.id + ":" + code), new Date(Date.now() + 10 * 60_000).toISOString(), f.id);
  await sendEmail({
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
  audit(ws.id, f.id, "file.otp_sent", "system", ctx, { to: f.client_email });
}

export function verifyOtp(f: FileRow, ws: Workspace, code: string, ctx: Ctx): boolean {
  if (!f.otp_hash || !f.otp_expires_at || f.otp_expires_at < now()) throw new AppError("The code has expired. Send a new one.", 400);
  if (f.otp_attempts >= 5) throw new AppError("Too many wrong codes. Send a new one.", 429);
  if (sha256(f.id + ":" + code.trim()) !== f.otp_hash) {
    run("UPDATE files SET otp_attempts = otp_attempts + 1 WHERE id = ?", f.id);
    audit(ws.id, f.id, "file.otp_failed", f.client_email, ctx);
    return false;
  }
  run("UPDATE files SET otp_verified_at = ?, otp_hash = NULL WHERE id = ?", now(), f.id);
  audit(ws.id, f.id, "file.otp_verified", f.client_email, ctx);
  return true;
}

const locks = new Set<string>();

function parsePng(dataUrl: string | undefined, what: string): Uint8Array {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  if (!m) throw new AppError(`Add your ${what} first.`);
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 600_000) throw new AppError(`Your ${what} image is too large.`);
  if (buf.subarray(1, 4).toString("latin1") !== "PNG" || buf.length < 24) throw new AppError(`Your ${what} image is invalid.`);
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
  if (locks.has(f.id)) throw new AppError("Already signing. Please wait.", 409);
  locks.add(f.id);
  try {
    if (!f.consent_at) {
      run("UPDATE files SET consent_at = ? WHERE id = ?", now(), f.id);
      audit(ws.id, f.id, "file.consented", f.client_email, ctx);
    }
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
        if (v) values.set(fl.id, { kind: "text", text: v });
        stored[fl.id] = v;
      }
    }
    if (!sigPng) sigPng = input.signature ? parsePng(input.signature, "signature") : undefined;
    const original = await getBlob(version.pdf_path);
    const signedPdf = Buffer.from(await stampFields(original, fields.filter((x) => x.role !== "firm"), values));
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
  const signerName = ws.countersigner_name || ws.legal_name;
  const values = new Map<string, StampValue>();
  const sigImg = ws.countersign_image ? new Uint8Array(await getBlob(ws.countersign_image)) : null;
  for (const fl of fields.filter((x) => x.role === "firm")) {
    if (fl.type === "signature" || fl.type === "initials") {
      values.set(fl.id, sigImg ? { kind: "image", png: sigImg } : { kind: "text", text: `/s/ ${signerName}` });
    } else if (fl.type === "name") values.set(fl.id, { kind: "text", text: signerName });
    else if (fl.type === "title" && ws.countersigner_title) values.set(fl.id, { kind: "text", text: ws.countersigner_title });
    else if (fl.type === "date") values.set(fl.id, { kind: "text", text: formatDate(t) });
    else if (fl.type === "company") values.set(fl.id, { kind: "text", text: ws.legal_name });
    else if (fl.type === "email" && ws.countersigner_email) values.set(fl.id, { kind: "text", text: ws.countersigner_email });
    else if (fl.type === "checkbox") values.set(fl.id, { kind: "check", on: true });
  }
  const base = await getBlob(doc.path);
  const stamped = await stampFields(base, fields.filter((x) => x.role === "firm"), values);
  const method = actor.kind === "system" ? "adopted signature, applied automatically" : "applied by " + actor.label;

  // the countersign event is written to the log only once the sealed file exists (below)
  const events = [...fileEvents(f.id), { seq: 0, file_id: f.id, type: "file.countersigned", actor: actor.label, ip: ctx.ip ?? null, user_agent: null, data_json: "{}", created_at: t }];
  const signedEv = events.find((e) => e.type === "file.signed");
  const final = await appendCertificate(stamped, {
    envelopeId: f.id,
    documentName: `${templateName(f)} (v${version.version}) – ${f.title}`,
    firmName: ws.legal_name,
    originalSha256: version.sha256,
    clientSignedSha256: doc.sha256,
    parties: [
      {
        role: "Client",
        name: f.client_name,
        email: f.client_email,
        signedAt: (f.client_signed_at ?? "").replace("T", " ").slice(0, 19) + " UTC",
        ip: signedEv?.ip ?? undefined,
        method: `${JSON.parse(signedEv?.data_json ?? "{}").method ?? "electronic"} signature, emailed link${ws.require_otp ? " + email code" : ""}`,
      },
      {
        role: `Countersigned for ${ws.legal_name}`,
        name: signerName,
        email: ws.countersigner_email || "-",
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
  await sendEmail({
    workspaceId: ws.id,
    fileId: f.id,
    kind: "completed",
    to: done.client_email,
    subject: `Signed: your ${templateName(done)} with ${ws.name}`,
    fromName: ws.sender_name,
    replyTo: ws.reply_to,
    html: layout({
      brand: ws.brand_color,
      firm: ws.name,
      heading: "All signed: here is your copy",
      body: `Thanks, ${escapeHtml(done.client_name.split(" ")[0])}. Both parties have signed. Your completed agreement is attached, and you can download it again from the link below.`,
      cta: link ? { href: link, label: "Download signed copy" } : undefined,
    }),
    attachments: [{ filename, content: finalBuf }],
  });
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
    const u = one<{ email: string }>("SELECT email FROM users WHERE id = ?", f.created_by);
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
      fromName: "Countersign",
      html: layout({ brand: ws.brand_color, firm: ws.name, heading, body, cta: { href: url, label: "Open file" }, foot: "You get this because you're on this file in Countersign." }),
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
    signing_url: f.status === "voided" ? null : signingLink(f),
    document_url: f.status === "completed" ? `${appUrl()}/api/v1/files/${f.id}/document` : null,
    app_url: `${appUrl()}/app/files/${f.id}`,
  };
}
