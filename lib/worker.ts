// Background loop: webhook retries, link expiry, reminders. Runs inside the app process.
import { all } from "./db";
import { attempt, dueDeliveries } from "./webhooks";
import { expireIfDue, getWorkspace, sendFile } from "./files";
import type { FileRow } from "./types";

export async function tick(): Promise<{ deliveries: number; expired: number; reminded: number }> {
  let deliveries = 0,
    expired = 0,
    reminded = 0;
  for (const d of dueDeliveries()) {
    await attempt(d);
    deliveries++;
  }
  const open = all<FileRow>("SELECT * FROM files WHERE status IN ('sent','viewed') LIMIT 500");
  const t = Date.now();
  for (const f of open) {
    try {
      const ws = getWorkspace(f.workspace_id);
      const after = expireIfDue(f, ws);
      if (after.status === "expired") {
        expired++;
        continue;
      }
      const days = ws.reminder_days
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0)
        .sort((a, b) => a - b);
      const nextDay = days[f.reminders_sent];
      if (nextDay !== undefined && f.sent_at && t >= new Date(f.sent_at).getTime() + nextDay * 86400_000) {
        await sendFile(f, ws, "reminder", { kind: "system", label: "reminder schedule" }, {});
        reminded++;
      }
    } catch (e) {
      console.error("[worker] file", f.id, e);
    }
  }
  return { deliveries, expired, reminded };
}

const g = globalThis as unknown as { __csworker?: NodeJS.Timeout };

export function startWorker() {
  if (g.__csworker || process.env.DISABLE_WORKER) return;
  const run = () => tick().catch((e) => console.error("[worker]", e));
  g.__csworker = setInterval(run, 60_000);
  setTimeout(run, 5_000);
}
