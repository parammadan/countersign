// The Document Intelligence server action takes the workspace, user and role from the server session only: form
// fields naming another workspace or user are ignored. Session and cache are stubbed; the database is temporary.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURES } from "./fixtures";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-intake-act-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

type Sess = { userId: string; userName: string; userEmail: string; workspaceId: string; role: "owner" | "admin" | "staff" };
let current: Sess | null = null;
vi.mock("@/lib/auth", () => ({
  requireSession: async () => {
    if (!current) throw new Error("redirect:/login");
    return current;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const SERVICES = FIXTURES.find((f) => f.id === "services-ok")!.pages.join("\f");
const staffA: Sess = { userId: "u_sa", userName: "Staff A", userEmail: "sa@example.com", workspaceId: "ws_a", role: "staff" };
const ownerB: Sess = { userId: "u_ob", userName: "Owner B", userEmail: "ob@example.test", workspaceId: "ws_b", role: "owner" };

describe("readDocumentAction", () => {
  let db: typeof import("../../lib/db");
  let act: typeof import("../../app/intake-actions");
  beforeAll(async () => {
    db = await import("../../lib/db");
    act = await import("../../app/intake-actions");
    const t = new Date().toISOString();
    for (const ws of ["ws_a", "ws_b"])
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", ws, ws, `${ws} LLC`, ws, "Avery Tester", `a-${ws}@example.com`, `inb_${ws}`, t);
    for (const u of [staffA, ownerB]) {
      db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", u.userId, u.userEmail, u.userName, "x", t);
      db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", u.workspaceId, u.userId, u.role, t);
    }
  });

  it("refuses without a session", async () => {
    current = null;
    const f = new FormData();
    f.set("text", SERVICES);
    await expect(act.readDocumentAction(f)).rejects.toThrow(/redirect/);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM sqlite_schema WHERE name = 'intake_results'")!.n === 0 || db.one<{ n: number }>("SELECT COUNT(*) n FROM intake_results")!.n === 0).toBe(true);
  });

  it("defence (cross-tenant): workspace, user and role fields in the form are ignored; the result belongs to the session's workspace", async () => {
    current = staffA;
    const f = new FormData();
    f.set("text", SERVICES);
    f.set("workspaceId", "ws_b");
    f.set("userId", "u_ob");
    f.set("role", "owner");
    const r = await act.readDocumentAction(f);
    expect(r.ok).toBe(true);
    const row = db.one<{ workspace_id: string; created_by: string }>("SELECT workspace_id, created_by FROM intake_results WHERE id = ?", r.ok ? r.id : "");
    expect(row).toEqual({ workspace_id: "ws_a", created_by: "u_sa" });
    const ev = db.all<{ workspace_id: string }>("SELECT workspace_id FROM wf_events WHERE idempotency_key = ?", `intake:${r.ok ? r.id : ""}`);
    expect(ev).toEqual([{ workspace_id: "ws_a" }]);
  });

  it("defence (cross-tenant): the other workspace's owner cannot read it through the service", async () => {
    current = staffA;
    const f = new FormData();
    f.set("text", SERVICES);
    const r = await act.readDocumentAction(f);
    const svc = await import("../../lib/intake/service");
    expect(svc.getIntake(ownerB, r.ok ? r.id : "")).toMatchObject({ ok: false });
  });

  it("returns a message for an empty form or an oversized file, and reads nothing", async () => {
    current = staffA;
    expect(await act.readDocumentAction(new FormData())).toEqual({ ok: false, message: "Upload a file or paste the text." });
    const f = new FormData();
    f.set("file", new File([new Uint8Array(2_000_000)], "big.pdf", { type: "application/pdf" }));
    expect(await act.readDocumentAction(f)).toMatchObject({ ok: false, message: expect.stringMatching(/1\.9 MB/) });
  });
});
