// Email log queries against a hand-built database with more than 200 emails: totals cover every email in the
// workspace (not just the newest 200), each filter returns only its state, pages cover every row exactly once,
// and one workspace never sees another's emails.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-outbox-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

const NOW = Date.parse("2026-11-06T12:00:00Z");
// two rows share each timestamp, so paging must not depend on created_at alone
const at = (i: number) => new Date(NOW - Math.floor(i / 2) * 60_000).toISOString();

type Seed = { id: string; status: string; at: string };
// the log's order: newest first, ties broken by id (descending)
const order = (rows: Seed[]) => [...rows].sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1)).map((r) => r.id);

describe("email log queries", () => {
  let q: typeof import("../components/outbox/query");
  let delivery: typeof import("../components/outbox/delivery");
  const A: Seed[] = [];
  const B: Seed[] = [];

  function email(ws: string, i: number, status: string, list: Seed[]) {
    const id = `em_${ws}_${String(i).padStart(3, "0")}`;
    dbm.run(
      "INSERT INTO emails (id, workspace_id, file_id, kind, to_email, subject, html, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, ws, null, "invite", `client${i}@example.com`, `Workspace ${ws} email ${i}`, "<html></html>", status, status === "failed" ? "550 refused" : null, at(i),
    );
    list.push({ id, status, at: at(i) });
  }
  let dbm: typeof import("../lib/db");

  beforeAll(async () => {
    dbm = await import("../lib/db");
    q = await import("../components/outbox/query");
    delivery = await import("../components/outbox/delivery");
    // workspace A: 230 emails, newest first by index; the 20 oldest are all failed, so they sit outside the newest 200
    for (let i = 0; i < 230; i++) {
      const status = i >= 210 ? "failed" : i % 5 === 0 ? "failed" : i % 5 === 4 ? "logged" : i % 7 === 3 ? "queued" : "sent";
      email("A", i, status, A);
    }
    // workspace B: 15 emails of every kind
    for (let i = 0; i < 15; i++) email("B", i, ["sent", "failed", "logged"][i % 3], B);
  });

  const expected = (rows: Seed[]) => {
    const c = { all: rows.length, delivered: 0, failed: 0, logged: 0 };
    for (const r of rows) c[delivery.deliveryOf(r.status)]++;
    return c;
  };

  it("totals per state are exact for the whole workspace and never include another workspace", () => {
    const a = q.countEmails("A");
    expect(a).toEqual(expected(A));
    expect(a.all).toBe(230);
    // the old failures count: more failures than the newest 200 hold
    const newest200Failed = A.slice(0, 200).filter((r) => r.status === "failed").length;
    expect(a.failed).toBe(newest200Failed + 20 + A.slice(200, 210).filter((r) => r.status === "failed").length);
    expect(a.failed).toBeGreaterThan(newest200Failed);
    expect(q.countEmails("B")).toEqual(expected(B));
    expect(q.countEmails("nobody")).toEqual({ all: 0, delivered: 0, failed: 0, logged: 0 });
  });

  function walk(ws: string, f: import("../components/outbox/delivery").DeliveryFilter) {
    const first = q.emailPage(ws, f, 1);
    const ids: string[] = [];
    for (let p = 1; p <= first.pages; p++) {
      const pg = q.emailPage(ws, f, p);
      expect(pg.page).toBe(p);
      expect(pg.rows.length).toBeLessThanOrEqual(q.PAGE_SIZE);
      expect(pg.from).toBe((p - 1) * q.PAGE_SIZE + 1);
      expect(pg.to).toBe(pg.from + pg.rows.length - 1);
      ids.push(...pg.rows.map((r) => r.id));
      for (const r of pg.rows) expect(r.id.startsWith(`em_${ws}_`)).toBe(true);
    }
    return { first, ids };
  }

  it("each filter returns only its state, and pages cover every row exactly once", () => {
    for (const f of ["all", "delivered", "failed", "logged"] as const) {
      const want = order(A.filter((r) => f === "all" || delivery.deliveryOf(r.status) === f));
      const { first, ids } = walk("A", f);
      expect(first.total).toBe(want.length);
      expect(first.pages).toBe(Math.ceil(want.length / q.PAGE_SIZE));
      expect(new Set(ids).size).toBe(ids.length); // no overlap
      expect(ids).toEqual(want); // no gaps, newest first
    }
    const failed = walk("A", "failed").ids;
    expect(failed).toContain("em_A_229"); // the oldest failure is reachable
    for (const id of failed) expect(A.find((r) => r.id === id)!.status).toBe("failed");
    for (const id of walk("A", "logged").ids) expect(["logged", "queued"]).toContain(A.find((r) => r.id === id)!.status);
    for (const id of walk("A", "delivered").ids) expect(A.find((r) => r.id === id)!.status).toBe("sent");
  });

  it("workspace B sees only its own emails", () => {
    const { first, ids } = walk("B", "all");
    expect(first.total).toBe(15);
    expect(first.pages).toBe(1);
    expect(ids).toEqual(order(B));
  });

  it("clamps out-of-range and invalid pages", () => {
    const last = q.emailPage("A", "all", 1).pages;
    expect(last).toBe(5);
    expect(q.emailPage("A", "all", 999).page).toBe(last);
    expect(q.emailPage("A", "all", 999).rows.map((r) => r.id)).toEqual(q.emailPage("A", "all", last).rows.map((r) => r.id));
    expect(q.emailPage("A", "all", 0).page).toBe(1);
    expect(q.emailPage("A", "all", -3).page).toBe(1);
    expect(q.emailPage("A", "all", NaN).page).toBe(1);
    expect(q.emailPage("nobody", "all", 7)).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0, rows: [] });
    for (const v of [undefined, "", "0", "-1", "abc", "1.5", "2e3", " 2", "1;DROP TABLE emails"]) expect(q.parsePage(v)).toBe(1);
    expect(q.parsePage("3")).toBe(3);
  });

  it("an invalid filter falls back to all", () => {
    for (const v of [undefined, "", "nonsense", "sent", "ALL", "failed' OR '1'='1"]) expect(delivery.parseFilter(v)).toBe("all");
    expect(q.emailPage("A", delivery.parseFilter("failed' OR 1=1 --"), 1).total).toBe(230);
    // a value that slips past the type system is treated as all, not passed to SQL
    expect(q.emailPage("A", "bogus" as never, 1).total).toBe(230);
  });
});
