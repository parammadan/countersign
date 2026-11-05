"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { all, one, run, tx } from "@/lib/db";
import { createSession, destroySession, hashPassword, requireAdmin, requireSession, verifyPassword } from "@/lib/auth";
import { AppError, countersign, createFile, getFile, getWorkspace, sendFile, voidFile } from "@/lib/files";
import { ctxFromHeaders } from "@/lib/http";
import { id, now, sha256, token } from "@/lib/util";
import { audit } from "@/lib/audit";
import { clientIp, limited } from "@/lib/ratelimit";
import { NewFileBody } from "@/lib/schemas";
import { draftFromVersion } from "@/lib/templates";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { layout, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/paths";
import { escapeHtml } from "@/lib/util";
import { checkWebhookUrl } from "@/lib/ssrf";

export type FormState = { error?: string; ok?: string; secret?: string } | undefined;

const s = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

async function throttle(bucket: string, max: number) {
  const ip = clientIp(await headers());
  if (limited(`${bucket}:${ip}`, max, 60_000)) throw new AppError("Too many attempts. Wait a minute and try again.", 429);
}

function fail(e: unknown): FormState {
  if (e instanceof AppError) return { error: e.message };
  if (e instanceof z.ZodError) return { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  if (e && typeof e === "object" && "digest" in e) throw e; // let redirect() through
  console.error(e);
  return { error: "Something went wrong. Please try again." };
}

// ---------- auth ----------

const Signup = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(320),
  password: z.string().min(8, "Use at least 8 characters").max(200),
  firm: z.string().trim().min(2, "Enter your firm's name").max(160),
  legal: z.string().trim().max(200).optional(),
});

export async function signupAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    await throttle("signup", 10);
    const b = Signup.parse({ name: s(fd.get("name")), email: s(fd.get("email")), password: String(fd.get("password") ?? ""), firm: s(fd.get("firm")), legal: s(fd.get("legal")) || undefined });
    if (one("SELECT 1 FROM users WHERE email = ?", b.email)) return { error: "An account with this email already exists. Sign in instead." };
    const uid = id("usr_");
    const wid = id("ws_");
    tx(() => {
      run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", uid, b.email, b.name, hashPassword(b.password), now());
      run(
        "INSERT INTO workspaces (id, name, legal_name, sender_name, reply_to, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        wid,
        b.firm,
        b.legal || b.firm,
        b.firm,
        b.email,
        b.name,
        b.email,
        token(18),
        now(),
      );
      run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", wid, uid, "owner", now());
    });
    audit(wid, null, "workspace.created", b.email);
    await createSession(uid, wid);
  } catch (e) {
    return fail(e);
  }
  redirect("/app");
}

export async function loginAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    await throttle("login", 10);
    const email = s(fd.get("email")).toLowerCase();
    const pw = String(fd.get("password") ?? "");
    const u = one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", email);
    if (!u || !verifyPassword(pw, u.password_hash)) return { error: "Email or password is wrong." };
    const m = one<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1", u.id);
    if (!m) return { error: "This account isn't part of a workspace." };
    await createSession(u.id, m.workspace_id);
  } catch (e) {
    return fail(e);
  }
  const next = s(fd.get("next"));
  redirect(next.startsWith("/app") ? next : "/app");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function acceptInviteAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    await throttle("invite", 10);
    const tok = s(fd.get("token"));
    const inv = one<{ id: string; workspace_id: string; email: string; role: string; accepted_at: string | null }>("SELECT * FROM invites WHERE token_hash = ?", sha256(tok));
    if (!inv || inv.accepted_at) return { error: "This invite link is invalid or was already used." };
    const name = s(fd.get("name"));
    const pw = String(fd.get("password") ?? "");
    let u = one<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", inv.email);
    if (u) {
      if (!verifyPassword(pw, u.password_hash)) return { error: "You already have an account: enter its password to join." };
    } else {
      if (!name) return { error: "Enter your name." };
      if (pw.length < 8) return { error: "Use a password of at least 8 characters." };
      const uid = id("usr_");
      run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", uid, inv.email, name.slice(0, 120), hashPassword(pw), now());
      u = { id: uid, password_hash: "" };
    }
    tx(() => {
      run("INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", inv.workspace_id, u!.id, inv.role, now());
      run("UPDATE invites SET accepted_at = ? WHERE id = ?", now(), inv.id);
    });
    audit(inv.workspace_id, null, "member.joined", inv.email);
    await createSession(u.id, inv.workspace_id);
  } catch (e) {
    return fail(e);
  }
  redirect("/app");
}

// ---------- files ----------

export async function createFileAction(_: FormState, fd: FormData): Promise<FormState> {
  let fid = "";
  try {
    const sess = await requireSession();
    const ws = getWorkspace(sess.workspaceId);
    const prefill: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("prefill.") && typeof v === "string") prefill[k.slice(8)] = v;
    const b = NewFileBody.parse({
      template_id: s(fd.get("templateId")) || undefined,
      client_name: s(fd.get("clientName")),
      client_email: s(fd.get("clientEmail")),
      client_company: s(fd.get("clientCompany")) || undefined,
      ref: s(fd.get("ref")) || undefined,
      title: s(fd.get("title")) || undefined,
      prefill,
    });
    const send = fd.get("intent") !== "draft";
    const f = await createFile(ws, b, { kind: "user", label: sess.userEmail, userId: sess.userId }, await ctxFromHeaders(), send);
    fid = f.id;
  } catch (e) {
    return fail(e);
  }
  redirect(`/app/files/${fid}?created=1`);
}

export async function fileAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireSession();
    const ws = getWorkspace(sess.workspaceId);
    const f = getFile(ws.id, s(fd.get("fileId")));
    const actor = { kind: "user" as const, label: sess.userEmail, userId: sess.userId };
    const ctx = await ctxFromHeaders();
    const op = s(fd.get("op"));
    let msg = "";
    if (op === "send") {
      await sendFile(f, ws, "invite", actor, ctx);
      msg = "Sent to the client.";
    } else if (op === "resend") {
      await sendFile(f, ws, "resend", actor, ctx);
      msg = "Re-sent the signing email.";
    } else if (op === "remind") {
      await sendFile(f, ws, "reminder", actor, ctx);
      msg = "Reminder sent.";
    } else if (op === "void") {
      voidFile(f, ws, actor, s(fd.get("reason")), ctx);
      msg = "File voided. The signing link no longer works.";
    } else if (op === "countersign") {
      if (sess.role === "staff") throw new AppError("Only admins can countersign.", 403);
      await countersign(f, ws, actor, ctx);
      msg = "Countersigned. The file is complete.";
    } else throw new AppError("Unknown action");
    revalidatePath(`/app/files/${f.id}`);
    return { ok: msg };
  } catch (e) {
    return fail(e);
  }
}

// ---------- agreements ----------

export async function newDraftAction(fd: FormData) {
  const sess = await requireAdmin();
  const v = draftFromVersion(sess.workspaceId, s(fd.get("versionId")), sess.userEmail);
  redirect(`/app/agreements/${v.id}`);
}

export async function templateAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireAdmin();
    const tid = s(fd.get("templateId"));
    const t = one<{ id: string }>("SELECT id FROM templates WHERE id = ? AND workspace_id = ?", tid, sess.workspaceId);
    if (!t) throw new AppError("Agreement not found", 404);
    const op = s(fd.get("op"));
    if (op === "rename") {
      const name = s(fd.get("name")).slice(0, 120);
      if (!name) throw new AppError("Enter a name.");
      run("UPDATE templates SET name = ? WHERE id = ?", name, tid);
    } else if (op === "default") {
      tx(() => {
        run("UPDATE templates SET is_default = 0 WHERE workspace_id = ?", sess.workspaceId);
        run("UPDATE templates SET is_default = 1 WHERE id = ?", tid);
      });
    } else if (op === "archive") {
      run("UPDATE templates SET archived = 1, is_default = 0 WHERE id = ?", tid);
    }
    revalidatePath("/app/agreements");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

// ---------- settings ----------

const Settings = z.object({
  name: z.string().trim().min(2).max(160),
  legal_name: z.string().trim().min(2).max(200),
  sender_name: z.string().trim().min(2).max(120),
  reply_to: z.union([z.literal(""), z.string().trim().email()]),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1f4fd1"),
  countersigner_name: z.string().trim().max(120),
  countersigner_title: z.string().trim().max(120),
  countersigner_email: z.union([z.literal(""), z.string().trim().email()]),
  auto_countersign: z.boolean(),
  require_otp: z.boolean(),
  reminder_days: z.string().regex(/^\s*(\d{1,2}\s*(,\s*\d{1,2}\s*)*)?$/, "Use days like 2,5"),
  expiry_days: z.coerce.number().int().min(1).max(90),
});

export async function settingsAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireAdmin();
    const b = Settings.parse({
      name: s(fd.get("name")),
      legal_name: s(fd.get("legal_name")),
      sender_name: s(fd.get("sender_name")),
      reply_to: s(fd.get("reply_to")),
      brand_color: s(fd.get("brand_color")),
      countersigner_name: s(fd.get("countersigner_name")),
      countersigner_title: s(fd.get("countersigner_title")),
      countersigner_email: s(fd.get("countersigner_email")),
      auto_countersign: fd.get("auto_countersign") === "on",
      require_otp: fd.get("require_otp") === "on",
      reminder_days: s(fd.get("reminder_days")),
      expiry_days: s(fd.get("expiry_days")),
    });
    run(
      `UPDATE workspaces SET name=?, legal_name=?, sender_name=?, reply_to=?, brand_color=?, countersigner_name=?, countersigner_title=?, countersigner_email=?,
       auto_countersign=?, require_otp=?, reminder_days=?, expiry_days=? WHERE id=?`,
      b.name,
      b.legal_name,
      b.sender_name,
      b.reply_to || null,
      b.brand_color,
      b.countersigner_name || null,
      b.countersigner_title || null,
      b.countersigner_email || null,
      b.auto_countersign ? 1 : 0,
      b.require_otp ? 1 : 0,
      b.reminder_days.replace(/\s+/g, ""),
      b.expiry_days,
      sess.workspaceId,
    );
    audit(sess.workspaceId, null, "workspace.settings_updated", sess.userEmail);
    revalidatePath("/app", "layout");
    return { ok: "Settings saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function inviteAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireAdmin();
    const ws = getWorkspace(sess.workspaceId);
    const email = z.string().trim().toLowerCase().email("Enter a valid email").parse(s(fd.get("email")));
    const role = s(fd.get("role")) === "admin" ? "admin" : "staff";
    if (one("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?", ws.id, email)) return { error: "They're already a member." };
    const tok = token(24);
    run("INSERT INTO invites (id, workspace_id, email, role, token_hash, created_at) VALUES (?,?,?,?,?,?)", id("inv_"), ws.id, email, role, sha256(tok), now());
    const link = `${appUrl()}/invite/${tok}`;
    await sendEmail({
      workspaceId: ws.id,
      kind: "invite_member",
      to: email,
      subject: `${sess.userName} invited you to ${ws.name} on Countersign`,
      fromName: "Countersign",
      html: layout({ brand: ws.brand_color, firm: ws.name, heading: `Join ${escapeHtml(ws.name)} on Countersign`, body: `${escapeHtml(sess.userName)} added you as ${role}.`, cta: { href: link, label: "Accept invite" } }),
    });
    audit(ws.id, null, "member.invited", sess.userEmail, {}, { email, role });
    revalidatePath("/app/settings");
    return { ok: `Invite sent to ${email}.`, secret: link };
  } catch (e) {
    return fail(e);
  }
}

export async function apiKeyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireAdmin();
    const op = s(fd.get("op"));
    if (op === "revoke") {
      run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?", now(), s(fd.get("id")), sess.workspaceId);
      revalidatePath("/app/developers");
      return { ok: "Key revoked." };
    }
    const name = s(fd.get("name")).slice(0, 60) || "API key";
    const key = `cs_live_${token(24)}`;
    run("INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)", id("key_"), sess.workspaceId, name, key.slice(0, 12), sha256(key), now());
    audit(sess.workspaceId, null, "api_key.created", sess.userEmail, {}, { name });
    revalidatePath("/app/developers");
    return { ok: "Key created. Copy it now: it won't be shown again.", secret: key };
  } catch (e) {
    return fail(e);
  }
}

export async function webhookAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireAdmin();
    const op = s(fd.get("op"));
    if (op === "delete") {
      run("UPDATE webhooks SET active = 0 WHERE id = ? AND workspace_id = ?", s(fd.get("id")), sess.workspaceId);
      revalidatePath("/app/developers");
      return { ok: "Webhook removed." };
    }
    const url = s(fd.get("url"));
    await checkWebhookUrl(url);
    const events = fd.getAll("events").map(String).filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
    const secret = `cswh_${token(24)}`;
    run("INSERT INTO webhooks (id, workspace_id, url, secret, events, created_at) VALUES (?,?,?,?,?,?)", id("wh_"), sess.workspaceId, url, secret, events.length ? events.join(",") : "*", now());
    audit(sess.workspaceId, null, "webhook.created", sess.userEmail, {}, { url });
    revalidatePath("/app/developers");
    return { ok: "Webhook added. Use this signing secret to verify deliveries:", secret };
  } catch (e) {
    return fail(e);
  }
}

export async function rotateInboundAction() {
  const sess = await requireAdmin();
  run("UPDATE workspaces SET inbound_token = ? WHERE id = ?", token(18), sess.workspaceId);
  revalidatePath("/app/developers");
}

// ---------- password reset ----------

export async function forgotAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    await throttle("forgot", 5);
    const email = s(fd.get("email")).toLowerCase();
    const u = one<{ id: string; name: string }>("SELECT id, name FROM users WHERE email = ?", email);
    const m = u && one<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id = ? LIMIT 1", u.id);
    if (u && m) {
      const tok = token(24);
      run("INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)", sha256(tok), u.id, new Date(Date.now() + 3600_000).toISOString(), now());
      await sendEmail({
        workspaceId: m.workspace_id,
        kind: "password_reset",
        to: email,
        subject: "Reset your Countersign password",
        fromName: "Countersign",
        html: layout({ brand: "#1f4fd1", firm: "Countersign", heading: "Reset your password", body: `Hi ${escapeHtml(u.name.split(" ")[0])}, use the button below to choose a new password. The link works for one hour. If you didn't ask for this, ignore this email.`, cta: { href: `${appUrl()}/reset/${tok}`, label: "Choose a new password" } }),
        logHtml: "<p>Password reset email (link withheld from the log).</p>",
      });
    }
    return { ok: "If that email has an account, a reset link is on its way." };
  } catch (e) {
    return fail(e);
  }
}

export async function resetAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    await throttle("reset", 10);
    const tok = s(fd.get("token"));
    const pw = String(fd.get("password") ?? "");
    if (pw.length < 8) return { error: "Use at least 8 characters." };
    const r = one<{ user_id: string; expires_at: string; used_at: string | null }>("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?", sha256(tok));
    if (!r || r.used_at || r.expires_at < now()) return { error: "This reset link is invalid or has expired. Ask for a new one." };
    const m = one<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1", r.user_id);
    if (!m) return { error: "This account isn't part of a workspace." };
    tx(() => {
      run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(pw), r.user_id);
      run("UPDATE password_resets SET used_at = ? WHERE token_hash = ?", now(), sha256(tok));
      run("DELETE FROM sessions WHERE user_id = ?", r.user_id);
    });
    await createSession(r.user_id, m.workspace_id);
  } catch (e) {
    return fail(e);
  }
  redirect("/app");
}

// ---------- CSV import ----------

export async function importCsvAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const sess = await requireSession();
    const ws = getWorkspace(sess.workspaceId);
    const file = fd.get("csv");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
    if (file.size > 1_000_000) return { error: "CSV files up to 1 MB." };
    const { parseCsv } = await import("@/lib/csv");
    const rows = parseCsv(await file.text());
    if (rows.length < 2) return { error: "The CSV needs a header row and at least one client." };
    if (rows.length > 201) return { error: "Import up to 200 files at a time." };
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
    const ci = { name: col("client_name", "name", "full_name", "client"), email: col("client_email", "email", "e-mail"), company: col("client_company", "company", "organization"), ref: col("ref", "reference", "external_ref", "file_ref", "matter", "case", "id"), title: col("title", "file_title") };
    if (ci.name < 0 || ci.email < 0) return { error: "The header row needs client_name and client_email columns." };
    const known = new Set(Object.values(ci).filter((i) => i >= 0));
    const actor = { kind: "user" as const, label: `${sess.userEmail} (CSV import)`, userId: sess.userId };
    const ctx = await ctxFromHeaders();
    let ok = 0;
    const errs: string[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const prefill: Record<string, string> = {};
      head.forEach((h, i) => {
        if (!known.has(i) && h && row[i] !== undefined) prefill[h.replace(/^prefill\./, "")] = row[i];
      });
      try {
        const b = NewFileBody.parse({ client_name: row[ci.name], client_email: row[ci.email], client_company: ci.company >= 0 ? row[ci.company] || undefined : undefined, ref: ci.ref >= 0 ? row[ci.ref] || undefined : undefined, title: ci.title >= 0 ? row[ci.title] || undefined : undefined, prefill });
        await createFile(ws, b, actor, ctx, true);
        ok++;
      } catch (e) {
        const msg = e instanceof AppError ? e.message : e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ") : "failed";
        errs.push(`Row ${r + 1}: ${msg}`);
      }
    }
    revalidatePath("/app/files");
    return errs.length ? { error: `${ok} sent, ${errs.length} skipped. ${errs.slice(0, 5).join(" · ")}${errs.length > 5 ? " …" : ""}` } : { ok: `${ok} file${ok === 1 ? "" : "s"} created and sent.` };
  } catch (e) {
    return fail(e);
  }
}
