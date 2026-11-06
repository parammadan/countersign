// Read-only data for the Overview. Every query is scoped to one workspace id, selects only the columns the
// screen shows (never token or OTP columns), and uses the existing indexes (files_ws, audit_file).
// Nothing here writes, and nothing is estimated: each number is a COUNT over real rows.

import { all, db } from "./db";

type Named = Record<string, string | number | null>;
// node:sqlite named parameters ($name); rows get a plain prototype so React can pass them on
function q<T>(sql: string, p: Named): T[] {
  return db()
    .prepare(sql)
    .all(p)
    .map((r) => ({ ...r }) as T);
}
import { EVENT_TEXT } from "./audit";

export type AttentionReason = "email_failed" | "countersign" | "copy_failed" | "declined" | "expired" | "waiting";

/** Highest priority first: things that block work or that the client can't fix on their own. */
export const ATTENTION_ORDER: AttentionReason[] = ["email_failed", "countersign", "copy_failed", "declined", "expired", "waiting"];

export const ATTENTION_TEXT: Record<AttentionReason, { label: string; action: string; adminAction?: boolean }> = {
  email_failed: { label: "Invitation email failed", action: "Check the address and resend" },
  countersign: { label: "Waiting for your countersignature", action: "Countersign and complete", adminAction: true },
  copy_failed: { label: "Signed copy email failed", action: "Send the client their copy" },
  declined: { label: "Client declined", action: "Read their reason and follow up" },
  expired: { label: "Signing link expired", action: "Reopen and send again" },
  waiting: { label: "Waiting 3+ days", action: "Send a reminder" },
};

export interface AttentionItem {
  fileId: string;
  title: string;
  clientName: string;
  ref: string | null;
  reason: AttentionReason;
  /** when the problem started (sent / signed / declined / expired time) */
  since: string | null;
}

export interface AgreementSummary {
  id: string;
  name: string;
  isDefault: boolean;
  liveVersion: number | null;
  liveVersionId: string | null;
  publishedAt: string | null;
  draftVersionId: string | null;
  draftVersion: number | null;
  files: number;
}

export interface ActivityItem {
  seq: number;
  type: string;
  text: string;
  actor: string;
  at: string;
  fileId: string | null;
  subject: string | null;
}

const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();

// One CASE decides each open file's single most urgent reason, so a file is never counted twice.
const REASON_SQL = `
  CASE
    WHEN f.email_status = 'failed' AND f.status IN ('sent','viewed') THEN 'email_failed'
    WHEN f.status = 'signed' THEN 'countersign'
    WHEN f.status = 'completed' AND f.copy_emailed_at IS NULL AND EXISTS (
      SELECT 1 FROM audit_events e WHERE e.file_id = f.id AND e.type = 'file.email_failed'
        AND e.data_json LIKE '%"kind":"completed"%' AND e.data_json LIKE '%"error":%'
    ) THEN 'copy_failed'
    WHEN f.status = 'declined' THEN 'declined'
    WHEN f.status = 'expired' OR (f.status IN ('sent','viewed') AND f.expires_at IS NOT NULL AND f.expires_at < $now) THEN 'expired'
    WHEN f.status IN ('sent','viewed') AND f.sent_at < $stale THEN 'waiting'
  END`;

const SINCE_SQL = `
  CASE
    WHEN f.status = 'signed' THEN f.client_signed_at
    WHEN f.status = 'declined' THEN f.declined_at
    WHEN f.status = 'completed' THEN f.completed_at
    WHEN f.status = 'expired' THEN f.expires_at
    ELSE f.sent_at
  END`;

export function attention(wsId: string, nowMs = Date.now(), limit = 8): { items: AttentionItem[]; total: number; byReason: Record<AttentionReason, number> } {
  const p = { $ws: wsId, $now: iso(nowMs), $stale: iso(nowMs - 3 * DAY) };
  const inner = `SELECT f.id, f.title, f.client_name, f.ref, ${REASON_SQL} AS reason, ${SINCE_SQL} AS since
                 FROM files f WHERE f.workspace_id = $ws AND f.status NOT IN ('voided','draft')`;
  const order = ATTENTION_ORDER.map((r, i) => `WHEN '${r}' THEN ${i}`).join(" ");
  const rows = q<{ id: string; title: string; client_name: string; ref: string | null; reason: AttentionReason; since: string | null }>(
    `SELECT * FROM (${inner}) WHERE reason IS NOT NULL ORDER BY CASE reason ${order} END, since ASC LIMIT ${Math.max(1, Math.floor(limit))}`,
    p,
  );
  const counts = q<{ reason: AttentionReason; n: number }>(`SELECT reason, COUNT(*) n FROM (${inner}) WHERE reason IS NOT NULL GROUP BY reason`, p);
  const byReason = Object.fromEntries(ATTENTION_ORDER.map((r) => [r, 0])) as Record<AttentionReason, number>;
  for (const c of counts) byReason[c.reason] = c.n;
  return {
    items: rows.map((r) => ({ fileId: r.id, title: r.title, clientName: r.client_name, ref: r.ref, reason: r.reason, since: r.since })),
    total: counts.reduce((a, c) => a + c.n, 0),
    byReason,
  };
}

export function fileMetrics(wsId: string, nowMs = Date.now()) {
  const p = { $ws: wsId, $now: iso(nowMs), $month: iso(nowMs - 30 * DAY) };
  const [r] = q<{ awaiting: number; opened: number; ready: number; ready30: number; total: number }>(
    `SELECT
       COALESCE(SUM(status IN ('sent','viewed') AND (expires_at IS NULL OR expires_at >= $now)), 0) AS awaiting,
       COALESCE(SUM(status = 'viewed' AND (expires_at IS NULL OR expires_at >= $now)), 0) AS opened,
       COALESCE(SUM(status = 'completed'), 0) AS ready,
       COALESCE(SUM(status = 'completed' AND completed_at > $month), 0) AS ready30,
       COUNT(*) AS total
     FROM files WHERE workspace_id = $ws`,
    p,
  );
  const durations = q<{ ms: number }>(
    `SELECT (julianday(client_signed_at) - julianday(sent_at)) * 86400000 AS ms FROM files
     WHERE workspace_id = $ws AND client_signed_at IS NOT NULL AND sent_at IS NOT NULL ORDER BY client_signed_at DESC LIMIT 50`,
    { $ws: wsId },
  )
    .map((d) => d.ms)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  return { ...r, medianSignMs: durations.length ? durations[Math.floor(durations.length / 2)] : null };
}

export function agreements(wsId: string): AgreementSummary[] {
  return all<{ id: string; name: string; is_default: number; live_id: string | null; live_version: number | null; published_at: string | null; draft_id: string | null; draft_version: number | null; files: number }>(
    `SELECT t.id, t.name, t.is_default, v.id AS live_id, v.version AS live_version, v.published_at,
       d.id AS draft_id, d.version AS draft_version,
       (SELECT COUNT(*) FROM files f WHERE f.workspace_id = t.workspace_id
          AND f.template_version_id IN (SELECT x.id FROM template_versions x WHERE x.template_id = t.id)) AS files
     FROM templates t
     LEFT JOIN template_versions v ON v.id = t.active_version_id
     LEFT JOIN template_versions d ON d.id = (SELECT y.id FROM template_versions y WHERE y.template_id = t.id AND y.status = 'draft' ORDER BY y.version DESC LIMIT 1)
     WHERE t.workspace_id = ? AND t.archived = 0
     ORDER BY t.is_default DESC, t.created_at DESC`,
    wsId,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    isDefault: !!r.is_default,
    liveVersion: r.live_version,
    liveVersionId: r.live_id,
    publishedAt: r.published_at,
    draftVersionId: r.draft_id,
    draftVersion: r.draft_version,
    files: r.files,
  }));
}

// Workspace-level events worth showing next to file events (no API keys, webhooks or team changes here).
const WORKSPACE_EVENTS: Record<string, (d: Record<string, unknown>) => { text: string; subject: string | null }> = {
  "template.uploaded": (d) => ({ text: "Agreement uploaded", subject: d.template ? `${d.template}${d.version ? `, version ${d.version}` : ""}` : null }),
  "template.published": (d) => ({ text: "Agreement published", subject: d.template ? `${d.template}${d.version ? `, version ${d.version}` : ""}` : null }),
  "workspace.countersignature_adopted": () => ({ text: "Firm countersignature adopted", subject: null }),
};

export function activity(wsId: string, limit = 10): ActivityItem[] {
  const types = Object.keys(WORKSPACE_EVENTS).map((t) => `'${t}'`).join(",");
  const rows = all<{ seq: number; type: string; actor: string; created_at: string; file_id: string | null; data_json: string; title: string | null; client_name: string | null }>(
    `SELECT e.seq, e.type, e.actor, e.created_at, e.file_id, e.data_json, f.title, f.client_name
     FROM audit_events e LEFT JOIN files f ON f.id = e.file_id AND f.workspace_id = e.workspace_id
     WHERE e.workspace_id = ? AND ((e.file_id IS NOT NULL AND f.id IS NOT NULL) OR e.type IN (${types}))
     ORDER BY e.seq DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    wsId,
  );
  return rows.map((r) => {
    if (r.file_id) {
      return { seq: r.seq, type: r.type, text: EVENT_TEXT[r.type] ?? r.type, actor: actorLabel(r.actor), at: r.created_at, fileId: r.file_id, subject: r.title };
    }
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(r.data_json || "{}");
    } catch {
      /* keep empty */
    }
    const w = WORKSPACE_EVENTS[r.type](d);
    return { seq: r.seq, type: r.type, text: w.text, actor: actorLabel(r.actor), at: r.created_at, fileId: null, subject: w.subject };
  });
}

/** Machine actors get a plain name; people are shown by the email they act under. */
export function actorLabel(actor: string) {
  if (actor === "system" || actor === "auto-countersign" || actor === "reminder schedule") return "Automatic";
  if (actor.startsWith("API key")) return "API";
  if (actor === "inbound webhook") return "Inbound webhook";
  return actor;
}

export type NextAction = { title: string; body: string; href?: string; cta?: string; tone: "setup" | "attention" | "clear" };

/** One recommendation, decided by fixed rules over the real state. No guessing, no AI. */
export function nextAction(s: {
  admin: boolean;
  agreements: AgreementSummary[];
  hasCountersignature: boolean;
  hasFiles: boolean;
  top?: AttentionItem;
  attentionTotal: number;
}): NextAction {
  const live = s.agreements.some((a) => a.liveVersion != null);
  const draft = s.agreements.find((a) => a.draftVersionId && a.liveVersion == null) ?? s.agreements.find((a) => a.draftVersionId);
  const ask = (what: string): NextAction => ({ title: `Waiting on an admin to ${what}`, body: "Only workspace admins can do this. Ask one to finish setting up.", tone: "setup" });

  if (!s.agreements.length)
    return s.admin
      ? { title: "Upload your client agreement", body: "Use the PDF or Word file you already send. We find where everyone signs; you check it and publish.", href: "/app/agreements", cta: "Upload agreement", tone: "setup" }
      : ask("upload the client agreement");
  if (!live)
    return s.admin
      ? { title: "Check the fields and publish", body: "Your agreement is uploaded. Confirm the signature fields we found, then publish it so new files can use it.", href: draft ? `/app/agreements/${draft.draftVersionId}` : "/app/agreements", cta: "Review fields", tone: "setup" }
      : ask("publish the agreement");
  if (!s.hasCountersignature)
    return s.admin
      ? { title: "Adopt your firm's countersignature", body: "It's applied the moment a client signs, so nobody has to countersign by hand.", href: "/app/settings#countersign", cta: "Adopt signature", tone: "setup" }
      : ask("adopt the firm's countersignature");
  if (s.top) {
    const t = ATTENTION_TEXT[s.top.reason];
    const more = s.attentionTotal > 1 ? ` ${s.attentionTotal - 1} more ${s.attentionTotal - 1 === 1 ? "file needs" : "files need"} attention below.` : "";
    const action = t.adminAction && !s.admin ? "An admin needs to do this." : `${t.action}.`;
    return { title: `${t.label}: ${s.top.clientName}`, body: `${s.top.title}. ${action}${more}`, href: `/app/files/${s.top.fileId}`, cta: "Open file", tone: "attention" };
  }
  if (!s.hasFiles)
    return { title: "Open your first client file", body: "Enter the client's name and email. The agreement goes out straight away and everything after that is automatic.", href: "/app/files/new", cta: "New file", tone: "setup" };
  return { title: "Everything is on track", body: "Nothing needs you right now. Open a new file when the next job starts.", href: "/app/files/new", cta: "New file", tone: "clear" };
}
