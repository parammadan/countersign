// Per-workspace rolling-24h cap on client invitation emails (lib/sendcap.ts), enforced in createFile/sendFile.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-sendcap-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = ["pw", process.pid, Date.now()].join("-");
type Mail = { to: string; subject: string };
const outbox: Mail[] = [];
(globalThis as unknown as { __csmailer: unknown }).__csmailer = { sendMail: async (m: Mail) => (outbox.push(m), { messageId: `<m${outbox.length}@test>` }) };

const sess = { userId: "usr_a", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_a", role: "owner" as const };
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("../lib/auth")>()), getSession: async () => sess, requireSession: async () => sess }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

let db: typeof import("../lib/db");
let files: typeof import("../lib/files");
let cap: typeof import("../lib/sendcap");
const actor = { kind: "system" as const, label: "test" };
const input = (n: number) => ({ clientName: "Jordan Sample", clientEmail: `client${n}@example.com` });
const fileCount = (ws: string) => db.one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE workspace_id = ?", ws)!.n;
const setVerified = (ws: string, on: boolean) => db.run("UPDATE users SET email_verified_at = ? WHERE id = ?", on ? new Date().toISOString() : null, `usr_${ws}`);
const addWs = (ws: string) => {
  const t = new Date().toISOString();
  db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", `usr_${ws}`, `${ws}@example.com`, "Owner Test", "x", t);
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", ws, "Northwind", "Northwind Advisory, LLC", "Northwind", "Avery Tester", `${ws}@example.com`, `inb_${ws}`, t);
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", ws, `usr_${ws}`, "owner", t);
};

beforeAll(async () => {
  db = await import("../lib/db");
  files = await import("../lib/files");
  cap = await import("../lib/sendcap");
  const tpl = await import("../lib/templates");
  addWs("ws_a");
  addWs("ws_b");
  for (const w of ["ws_a", "ws_b"]) {
    const ws = files.getWorkspace(w);
    const { version } = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/01-simple-one-page.pdf"), filename: "a.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, version.id, "test");
  }
});
beforeEach(() => {
  outbox.length = 0;
  delete process.env.INVITE_CAP_PER_DAY;
  delete process.env.INVITE_CAP_UNCONFIRMED_PER_DAY;
  db.run("DELETE FROM emails");
  setVerified("ws_a", true);
  setVerified("ws_b", true);
});

describe("env parsing", () => {
  it("falls back to the default for anything that isn't a positive whole number", () => {
    for (const bad of [undefined, "", "  ", "abc", "-5", "0", "1.5", "1e3", "NaN", "Infinity", "99999999999999999999"]) expect(cap.parseCap(bad, 7), String(bad)).toBe(7);
    expect(cap.parseCap(" 12 ", 7)).toBe(12);
  });
  it("defaults to 200 confirmed and 20 unconfirmed, and reads overrides", () => {
    expect(cap.inviteCap("ws_a")).toBe(200);
    setVerified("ws_a", false);
    expect(cap.inviteCap("ws_a")).toBe(20);
    process.env.INVITE_CAP_UNCONFIRMED_PER_DAY = "3";
    expect(cap.inviteCap("ws_a")).toBe(3);
    setVerified("ws_a", true);
    process.env.INVITE_CAP_PER_DAY = "junk";
    expect(cap.inviteCap("ws_a")).toBe(200);
  });
});

describe("createFile / sendFile", () => {
  it("sends under the cap", async () => {
    process.env.INVITE_CAP_PER_DAY = "2";
    await files.createFile(files.getWorkspace("ws_a"), input(1), actor, {});
    await files.createFile(files.getWorkspace("ws_a"), input(2), actor, {});
    expect(outbox).toHaveLength(2);
  });

  it("at the cap refuses with 429, sends nothing and creates no file", async () => {
    process.env.INVITE_CAP_PER_DAY = "2";
    const ws = files.getWorkspace("ws_a");
    await files.createFile(ws, input(1), actor, {});
    await files.createFile(ws, input(2), actor, {});
    const before = fileCount("ws_a");
    const err = await files.createFile(ws, input(3), actor, {}).catch((e) => e);
    expect(err).toBeInstanceOf(files.AppError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("This workspace has sent 2 invitations in the last 24 hours, the current limit. Try again later.");
    expect(outbox).toHaveLength(2);
    expect(fileCount("ws_a")).toBe(before);
  });

  it("refuses sending an existing draft, and counts resends, but not reminders", async () => {
    process.env.INVITE_CAP_PER_DAY = "1";
    const ws = files.getWorkspace("ws_a");
    const draft = await files.createFile(ws, input(1), actor, {}, false);
    const sent = await files.sendFile(draft, ws, "invite", actor, {});
    expect(outbox).toHaveLength(1);
    await expect(files.sendFile(sent, ws, "resend", actor, {})).rejects.toMatchObject({ status: 429 });
    await files.sendFile(sent, ws, "reminder", actor, {});
    expect(outbox).toHaveLength(2); // the reminder went out; the resend didn't
  });

  it("only counts the last 24 hours and only this workspace", async () => {
    process.env.INVITE_CAP_PER_DAY = "1";
    await files.createFile(files.getWorkspace("ws_a"), input(1), actor, {});
    await files.createFile(files.getWorkspace("ws_b"), input(2), actor, {}); // other workspace unaffected
    db.run("UPDATE emails SET created_at = ?", new Date(Date.now() - 25 * 3600_000).toISOString());
    await files.createFile(files.getWorkspace("ws_a"), input(3), actor, {});
    expect(outbox).toHaveLength(3);
  });

  it("an unconfirmed workspace has the lower cap (to its own team only, so use a member address)", async () => {
    process.env.INVITE_CAP_UNCONFIRMED_PER_DAY = "1";
    setVerified("ws_a", false);
    const ws = files.getWorkspace("ws_a");
    await files.createFile(ws, { clientName: "Owner Test", clientEmail: "ws_a@example.com" }, actor, {});
    await expect(files.createFile(ws, { clientName: "Owner Test", clientEmail: "ws_a@example.com", ref: "second" }, actor, {})).rejects.toMatchObject({ status: 429, message: expect.stringContaining("sent 1 invitations") });
    setVerified("ws_a", true); // confirming lifts it to the confirmed limit
    await files.createFile(ws, input(9), actor, {});
    expect(outbox).toHaveLength(2);
  });
});

describe("CSV import", () => {
  it("imports rows up to the cap and reports each refusal per row", async () => {
    process.env.INVITE_CAP_PER_DAY = "2";
    const { importCsvAction } = await import("../app/actions");
    const csv = "client_name,client_email\nA One,a1@example.com\nB Two,b2@example.com\nC Three,c3@example.com\nD Four,d4@example.com\n";
    const before = fileCount("ws_a");
    const fd = new FormData();
    fd.set("csv", new File([csv], "clients.csv", { type: "text/csv" }));
    const r = await importCsvAction({}, fd);
    expect(outbox.map((m) => m.to)).toEqual(["a1@example.com", "b2@example.com"]);
    expect(r?.error).toMatch(/^2 sent, 2 skipped\. Row 4: This workspace has sent 2 invitations in the last 24 hours/);
    expect(r?.error).toMatch(/Row 5: This workspace has sent 2 invitations/);
    expect(fileCount("ws_a") - before).toBe(2);
  });
});

describe("reminders can't bypass the cap", () => {
  it("refuses a reminder on a draft or an expired file and sends nothing", async () => {
    process.env.INVITE_CAP_PER_DAY = "1";
    const ws = files.getWorkspace("ws_a");
    await files.createFile(ws, input(1), actor, {});
    const draft = await files.createFile(ws, input(2), actor, {}, false);
    outbox.length = 0;
    await expect(files.sendFile(draft, ws, "reminder", actor, {})).rejects.toMatchObject({ status: 409 });
    expect(files.getFile(ws.id, draft.id).status).toBe("draft");
    db.run("UPDATE files SET status = 'expired' WHERE id = ?", draft.id);
    await expect(files.sendFile(files.getFile(ws.id, draft.id), ws, "reminder", actor, {})).rejects.toMatchObject({ status: 409 });
    expect(files.getFile(ws.id, draft.id).status).toBe("expired");
    expect(outbox).toHaveLength(0);
  });
});

describe("inbound webhook", () => {
  it("answers 429 over the cap and creates nothing; send:false still works", async () => {
    process.env.INVITE_CAP_PER_DAY = "1";
    const { POST } = await import("../app/api/inbound/[token]/route");
    const post = (n: number, extra: object = {}) =>
      POST(new Request("http://localhost:3000/api/inbound/inb_ws_b", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Jordan Sample", client_email: `hook${n}@example.com`, ...extra }) }), { params: Promise.resolve({ token: "inb_ws_b" }) });
    const before = fileCount("ws_b");
    expect((await post(1)).status).toBe(201);
    const res = await post(2);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("This workspace has sent 1 invitations in the last 24 hours, the current limit. Try again later.");
    expect(outbox).toHaveLength(1);
    expect(fileCount("ws_b") - before).toBe(1);
    expect((await post(3, { send: false })).status).toBe(201); // a draft sends nothing, so the cap doesn't apply
  });
});
