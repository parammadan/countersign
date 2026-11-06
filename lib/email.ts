import { run } from "./db";
import { escapeHtml, id, now } from "./util";
import { BRAND } from "./brand";

export type Attachment = { filename: string; content: Buffer };

export function emailMode(): "resend" | "smtp" | "outbox" {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  return "outbox";
}

type Mailer = { sendMail(m: Record<string, unknown>): Promise<{ messageId?: string }> };
const g = globalThis as unknown as { __csmailer?: Mailer };

// Any SMTP server works (a Gmail account with an app password needs no domain).
async function smtp(): Promise<Mailer> {
  if (g.__csmailer) return g.__csmailer;
  const nodemailer = (await import("nodemailer")).default;
  const port = Number(process.env.SMTP_PORT || 465);
  g.__csmailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    pool: true,
    maxConnections: 2,
  }) as unknown as Mailer;
  return g.__csmailer;
}

// Every email is recorded (the outbox doubles as a delivery log). If a provider
// key is configured it is also delivered; otherwise it stays in the outbox.
export async function sendEmail(opts: {
  workspaceId: string;
  fileId?: string | null;
  kind: string;
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  replyTo?: string | null;
  attachments?: Attachment[];
  /** sensitive email (codes, reset/invite links): this is stored instead of `html`, always */
  logHtml?: string;
  /** strings (e.g. signing links) replaced in the stored copy, so staff reading the log can't use them */
  redact?: string[];
}): Promise<{ id: string; delivered: boolean; error?: string }> {
  const eid = id("em_");
  let status = "logged";
  let providerId: string | null = null;
  let error: string | null = null;
  const mode = emailMode();
  const fromName = (opts.fromName || BRAND.systemSender).replace(/[<>"\r\n]/g, "");
  if (mode === "smtp") {
    try {
      const info = await (await smtp()).sendMail({
        from: { name: fromName, address: process.env.EMAIL_FROM || process.env.SMTP_USER },
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        replyTo: opts.replyTo || undefined,
        attachments: opts.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: "application/pdf" })),
      });
      status = "sent";
      providerId = info.messageId ?? null;
    } catch (e) {
      status = "failed";
      error = String((e as Error).message || e).slice(0, 300);
    }
  }
  if (mode === "resend") {
    try {
      const from = `${fromName} <${process.env.EMAIL_FROM || "onboarding@resend.dev"}>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [opts.to],
          subject: opts.subject,
          html: opts.html,
          reply_to: opts.replyTo || undefined,
          attachments: opts.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok) {
        status = "sent";
        providerId = body.id ?? null;
      } else {
        status = "failed";
        error = body.message || `HTTP ${res.status}`;
      }
    } catch (e) {
      status = "failed";
      error = String((e as Error).message || e);
    }
  }
  run(
    "INSERT INTO emails (id, workspace_id, file_id, kind, to_email, subject, html, status, provider_id, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    eid,
    opts.workspaceId,
    opts.fileId ?? null,
    opts.kind,
    opts.to,
    opts.logHtml ? opts.subject.replace(/\d{6}/, "••••••") : opts.subject,
    opts.logHtml ?? redactAll(opts.html, opts.redact),
    status,
    providerId,
    error,
    now(),
  );
  return { id: eid, delivered: status === "sent", error: error ?? undefined };
}

function redactAll(html: string, secrets?: string[]) {
  let out = html;
  for (const x of secrets ?? []) if (x) out = out.split(x).join("[personal link withheld from the log]").split(escapeHtml(x)).join("[personal link withheld from the log]");
  return out;
}

export function layout(opts: { brand: string; firm: string; heading: string; body: string; cta?: { href: string; label: string }; foot?: string }) {
  const color = /^#[0-9a-f]{6}$/i.test(opts.brand) ? opts.brand : BRAND.color;
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e6ec">
<tr><td style="height:6px;background:${color}"></td></tr>
<tr><td style="padding:28px 32px 8px;font-size:13px;color:#5b6474;font-weight:600;letter-spacing:.02em">${escapeHtml(opts.firm)}</td></tr>
<tr><td style="padding:0 32px;font-size:21px;font-weight:700;line-height:1.3">${escapeHtml(opts.heading)}</td></tr>
<tr><td style="padding:14px 32px 6px;font-size:15px;line-height:1.6">${opts.body}</td></tr>
${
  opts.cta
    ? `<tr><td style="padding:18px 32px 8px"><a href="${escapeHtml(opts.cta.href)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:7px;font-size:15px">${escapeHtml(opts.cta.label)}</a></td></tr>
<tr><td style="padding:6px 32px 0;font-size:12px;color:#8a92a1;word-break:break-all">Or paste this link into your browser: ${escapeHtml(opts.cta.href)}</td></tr>`
    : ""
}
<tr><td style="padding:24px 32px 28px;font-size:12px;color:#8a92a1;line-height:1.5">${opts.foot ?? `Sent with ${BRAND.name} on behalf of ` + escapeHtml(opts.firm) + ". Do not forward this email: the link is personal to you."}</td></tr>
</table></td></tr></table></body></html>`;
}
