import { run } from "./db";
import { escapeHtml, id, now } from "./util";

export type Attachment = { filename: string; content: Buffer };

export function emailMode(): "resend" | "outbox" {
  return process.env.RESEND_API_KEY ? "resend" : "outbox";
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
}): Promise<{ id: string; delivered: boolean; error?: string }> {
  const eid = id("em_");
  let status = "logged";
  let providerId: string | null = null;
  let error: string | null = null;
  if (process.env.RESEND_API_KEY) {
    try {
      const from = `${(opts.fromName || "Countersign").replace(/[<>"]/g, "")} <${process.env.EMAIL_FROM || "onboarding@resend.dev"}>`;
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
    opts.logHtml ?? opts.html,
    status,
    providerId,
    error,
    now(),
  );
  return { id: eid, delivered: status === "sent", error: error ?? undefined };
}

export function layout(opts: { brand: string; firm: string; heading: string; body: string; cta?: { href: string; label: string }; foot?: string }) {
  const color = /^#[0-9a-f]{6}$/i.test(opts.brand) ? opts.brand : "#1f4fd1";
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
<tr><td style="padding:24px 32px 28px;font-size:12px;color:#8a92a1;line-height:1.5">${opts.foot ?? "Sent with Countersign on behalf of " + escapeHtml(opts.firm) + ". Do not forward this email: the link is personal to you."}</td></tr>
</table></td></tr></table></body></html>`;
}
