import crypto from "node:crypto";
import { all, one, run } from "./db";
import { id, now } from "./util";
import { checkWebhookUrl } from "./ssrf";

export const WEBHOOK_EVENTS = ["file.created", "file.sent", "file.viewed", "file.signed", "file.completed", "file.declined", "file.expired", "file.voided"] as const;

type Hook = { id: string; url: string; secret: string; events: string };
type Delivery = { id: string; webhook_id: string; event: string; payload: string; attempts: number };

export function sign(secret: string, ts: string, body: string) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

export function emit(workspaceId: string, event: string, data: Record<string, unknown>) {
  const hooks = all<Hook>("SELECT id, url, secret, events FROM webhooks WHERE workspace_id = ? AND active = 1", workspaceId);
  const ids: string[] = [];
  for (const h of hooks) {
    const evs = h.events.split(",");
    if (!evs.includes("*") && !evs.includes(event)) continue;
    const did = id("wd_");
    const payload = JSON.stringify({ id: did, event, created_at: now(), data });
    run(
      "INSERT INTO webhook_deliveries (id, webhook_id, workspace_id, event, payload, status, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      did,
      h.id,
      workspaceId,
      event,
      payload,
      "pending",
      0,
      now(),
      now(),
    );
    ids.push(did);
  }
  // fire-and-forget first attempt; the worker retries failures
  for (const d of ids) void attempt(d);
}

const BACKOFF_MIN = [1, 5, 30, 120, 720];

export async function attempt(deliveryId: string) {
  const d = one<Delivery & { status: string }>("SELECT * FROM webhook_deliveries WHERE id = ?", deliveryId);
  if (!d || d.status === "delivered" || d.status === "dead") return;
  const h = one<Hook>("SELECT * FROM webhooks WHERE id = ?", d.webhook_id);
  if (!h) return;
  const ts = Math.floor(Date.now() / 1000).toString();
  let code: number | null = null;
  let err: string | null = null;
  try {
    await checkWebhookUrl(h.url);
    const res = await fetch(h.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Countersign-Webhooks/1.0",
        "X-Countersign-Event": d.event,
        "X-Countersign-Delivery": d.id,
        "X-Countersign-Signature": `t=${ts},v1=${sign(h.secret, ts, d.payload)}`,
      },
      body: d.payload,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    code = res.status;
    if (!res.ok) err = `HTTP ${res.status}`;
  } catch (e) {
    err = String((e as Error).message || e).slice(0, 200);
  }
  const attempts = d.attempts + 1;
  if (!err) {
    run("UPDATE webhook_deliveries SET status='delivered', attempts=?, response_code=?, last_error=NULL WHERE id=?", attempts, code, d.id);
  } else if (attempts > BACKOFF_MIN.length) {
    run("UPDATE webhook_deliveries SET status='dead', attempts=?, response_code=?, last_error=? WHERE id=?", attempts, code, err, d.id);
  } else {
    const next = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
    run("UPDATE webhook_deliveries SET status='retrying', attempts=?, response_code=?, last_error=?, next_attempt_at=? WHERE id=?", attempts, code, err, next, d.id);
  }
}

export function dueDeliveries(): string[] {
  return all<{ id: string }>("SELECT id FROM webhook_deliveries WHERE status IN ('pending','retrying') AND next_attempt_at <= ? LIMIT 50", now()).map((r) => r.id);
}
