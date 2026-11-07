import { all } from "@/lib/db";
import { DELIVERIES, type Delivery, type DeliveryFilter, type LoggedEmail, deliveryOf } from "./delivery";

// Email log queries. Filtering, counting and paging all happen in SQL over every email in the workspace,
// so the totals and the filtered lists never depend on how many emails the page happens to load.

export const PAGE_SIZE = 50;

// Fixed SQL per filter: the filter value is checked against an allow-list and never reaches SQL as text.
const WHERE: Record<DeliveryFilter, string> = {
  all: "",
  delivered: " AND status = 'sent'",
  failed: " AND status = 'failed'",
  logged: " AND status NOT IN ('sent', 'failed')",
};

/** Totals per delivery state over every email in the workspace, from one GROUP BY. */
export function countEmails(workspaceId: string): Record<DeliveryFilter, number> {
  const c: Record<DeliveryFilter, number> = { all: 0, delivered: 0, failed: 0, logged: 0 };
  for (const r of all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM emails WHERE workspace_id = ? GROUP BY status", workspaceId)) {
    const n = Number(r.n);
    c[deliveryOf(r.status)] += n;
    c.all += n;
  }
  return c;
}

/** `?page=` as a positive integer; anything else is page 1. */
export function parsePage(v: string | undefined): number {
  if (!v || !/^\d{1,9}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 1 ? n : 1;
}

export type EmailPage = {
  rows: LoggedEmail[];
  counts: Record<DeliveryFilter, number>;
  total: number; // emails matching the filter
  page: number; // clamped to 1..pages
  pages: number;
  from: number; // 1-based index of the first row shown (0 when none)
  to: number;
};

export function emailPage(workspaceId: string, filter: DeliveryFilter, page: number, pageSize = PAGE_SIZE): EmailPage {
  const f: DeliveryFilter = filter === "all" || (DELIVERIES as readonly Delivery[]).includes(filter) ? filter : "all";
  const counts = countEmails(workspaceId);
  const total = counts[f];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const offset = (p - 1) * pageSize;
  const rows = all<LoggedEmail>(
    `SELECT id, file_id, kind, to_email, subject, status, created_at, error FROM emails WHERE workspace_id = ?${WHERE[f]} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    workspaceId,
    pageSize,
    offset,
  );
  return { rows, counts, total, page: p, pages, from: rows.length ? offset + 1 : 0, to: offset + rows.length };
}
