// Overview numbers against a hand-built database: every count must equal what the fixture rows say,
// one workspace must never see another's rows, and the next action must follow the real state.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-dash-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86400_000).toISOString();
const ahead = (days: number) => new Date(NOW + days * 86400_000).toISOString();

describe("overview data", () => {
  let d: typeof import("../lib/dashboard");
  let db: typeof import("../lib/db");

  function workspace(id: string) {
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id, `Firm ${id}`, `Firm ${id} LLC`, `Firm ${id}`, "Avery Tester", `avery-${id}@example.com`, `inb_${id}`, ago(60),
    );
  }
  function version(id: string, ws: string, tpl: string, n: number, status: "draft" | "published") {
    db.run(
      "INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at, published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, tpl, ws, n, "a.pdf", "x", "x", "0", "[]", "[]", "{}", status, ago(50), status === "published" ? ago(49) : null,
    );
  }
  function template(id: string, ws: string, name: string, live: string | null, archived = 0) {
    db.run("INSERT INTO templates (id, workspace_id, name, active_version_id, is_default, archived, created_at) VALUES (?,?,?,?,?,?,?)", id, ws, name, live, 0, archived, ago(50));
  }
  let n = 0;
  function file(ws: string, tv: string, status: string, f: Partial<Record<string, string | null>> = {}) {
    const id = `file_${++n}`;
    db.run(
      `INSERT INTO files (id, workspace_id, template_version_id, title, client_name, client_email, status, token_hash, sent_at, viewed_at, client_signed_at, completed_at, declined_at, voided_at, expires_at, email_status, copy_emailed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ws, tv, `Agreement: Client ${n}`, `Client ${n}`, `client${n}@example.com`, status, `secret-token-hash-${n}`,
      f.sent_at ?? (status === "draft" ? null : ago(1)), f.viewed_at ?? null, f.client_signed_at ?? null, f.completed_at ?? null,
      f.declined_at ?? null, f.voided_at ?? null, f.expires_at ?? ahead(10), f.email_status ?? "sent", f.copy_emailed_at ?? null, f.created_at ?? ago(2),
    );
    return id;
  }
  const ev = (ws: string, file: string | null, type: string, actor: string, data: object = {}) =>
    db.run("INSERT INTO audit_events (workspace_id, file_id, type, actor, data_json, created_at) VALUES (?,?,?,?,?,?)", ws, file, type, actor, JSON.stringify(data), ago(0.5));

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = await import("../lib/db");
    d = await import("../lib/dashboard");
    workspace("A");
    workspace("B");
    template("tA", "A", "Engagement Letter", null);
    template("tC", "A", "Retainer", null);
    template("tX", "A", "Old agreement", null, 1); // archived: not listed
    template("tB", "B", "B's agreement", null);
    version("tvA1", "A", "tA", 1, "published");
    version("tvA2", "A", "tA", 2, "draft");
    version("tvC1", "A", "tC", 1, "draft");
    version("tvX1", "A", "tX", 1, "published");
    version("tvB1", "B", "tB", 1, "published");
    for (const [t, v] of [["tA", "tvA1"], ["tX", "tvX1"], ["tB", "tvB1"]]) db.run("UPDATE templates SET active_version_id = ? WHERE id = ?", v, t);

    ids.fresh = file("A", "tvA1", "sent", { sent_at: ago(1) }); // awaiting, not attention
    ids.opened = file("A", "tvA1", "viewed", { sent_at: ago(2), viewed_at: ago(1) }); // awaiting + opened
    ids.waiting = file("A", "tvA1", "sent", { sent_at: ago(4) }); // waiting 3+ days
    ids.failed = file("A", "tvA1", "sent", { sent_at: ago(5), email_status: "failed" }); // email_failed beats waiting
    ids.lapsed = file("A", "tvA1", "viewed", { sent_at: ago(20), expires_at: ago(1) }); // expired by date, status not flipped yet
    ids.expired = file("A", "tvA1", "expired", { sent_at: ago(30), expires_at: ago(16) });
    ids.declined = file("A", "tvA1", "declined", { declined_at: ago(2) });
    ids.signed = file("A", "tvA1", "signed", { client_signed_at: ago(0.2) }); // needs manual countersign
    ids.done = file("A", "tvA1", "completed", { sent_at: ago(3), client_signed_at: ago(2), completed_at: ago(2), copy_emailed_at: ago(2) });
    ids.doneOld = file("A", "tvA1", "completed", { sent_at: ago(41), client_signed_at: ago(40), completed_at: ago(40), copy_emailed_at: ago(40) });
    ids.copyFail = file("A", "tvA1", "completed", { client_signed_at: ago(1), completed_at: ago(1) });
    ids.copyLogged = file("A", "tvA1", "completed", { client_signed_at: ago(1), completed_at: ago(1) }); // email off: not a failure
    ids.voided = file("A", "tvA1", "voided", { email_status: "failed", voided_at: ago(1) }); // voided never needs attention
    ids.draft = file("A", "tvA1", "draft");
    ev("A", ids.copyFail, "file.email_failed", "system", { to: "x@example.com", kind: "completed", error: "550 mailbox unavailable" });
    ev("A", ids.copyLogged, "file.email_failed", "system", { to: "x@example.com", kind: "completed" }); // pre-fix false event, no error
    ev("A", ids.signed, "file.signed", "client7@example.com");
    ev("A", null, "template.published", "avery-A@example.com", { template: "Engagement Letter", version: 1 });
    ev("A", null, "api_key.created", "avery-A@example.com", { name: "CRM sync" }); // not shown in activity

    // workspace B: noisy rows that must never leak into A
    file("B", "tvB1", "sent", { sent_at: ago(9), email_status: "failed" });
    file("B", "tvB1", "signed", { client_signed_at: ago(1) });
    file("B", "tvB1", "completed", { completed_at: ago(1) });
    ev("B", null, "template.published", "b@example.com", { template: "B's agreement", version: 1 });
  });

  it("puts each open problem in exactly one bucket, highest priority first", () => {
    const a = d.attention("A", NOW, 50);
    const reasonOf = Object.fromEntries(a.items.map((i) => [i.fileId, i.reason]));
    expect(reasonOf).toEqual({
      [ids.failed]: "email_failed",
      [ids.signed]: "countersign",
      [ids.copyFail]: "copy_failed",
      [ids.declined]: "declined",
      [ids.lapsed]: "expired",
      [ids.expired]: "expired",
      [ids.waiting]: "waiting",
    });
    expect(a.total).toBe(7);
    expect(a.byReason).toEqual({ email_failed: 1, countersign: 1, copy_failed: 1, declined: 1, expired: 2, waiting: 1 });
    expect(a.items.map((i) => i.reason)).toEqual(["email_failed", "countersign", "copy_failed", "declined", "expired", "expired", "waiting"]);
    expect(a.items[0]).not.toHaveProperty("token_hash");
  });

  it("limits the list but not the total", () => {
    const a = d.attention("A", NOW, 3);
    expect(a.items).toHaveLength(3);
    expect(a.total).toBe(7);
  });

  it("counts files exactly", () => {
    const m = d.fileMetrics("A", NOW);
    expect(m.awaiting).toBe(4); // fresh, opened, waiting, failed (lapsed is past its expiry)
    expect(m.opened).toBe(1);
    expect(m.ready).toBe(4); // every completed file
    expect(m.ready30).toBe(3); // doneOld finished 40 days ago
    expect(m.total).toBe(14);
    expect(m.medianSignMs).toBeGreaterThan(0);
  });

  it("lists live and draft agreements, skipping archived ones", () => {
    const ag = d.agreements("A");
    expect(ag.map((a) => a.name).sort()).toEqual(["Engagement Letter", "Retainer"]);
    const eng = ag.find((a) => a.name === "Engagement Letter")!;
    expect(eng).toMatchObject({ liveVersion: 1, draftVersion: 2, draftVersionId: "tvA2", files: 14 });
    expect(ag.find((a) => a.name === "Retainer")).toMatchObject({ liveVersion: null, draftVersionId: "tvC1", files: 0 });
  });

  it("never mixes workspaces", () => {
    expect(d.attention("B", NOW).total).toBe(2);
    expect(d.fileMetrics("B", NOW)).toMatchObject({ awaiting: 1, ready: 1, total: 3 });
    expect(d.agreements("B").map((a) => a.name)).toEqual(["B's agreement"]);
    expect(d.activity("B").map((x) => x.subject)).toEqual(["B's agreement, version 1"]);
    expect(JSON.stringify(d.activity("A"))).not.toContain("B's agreement");
    expect(d.attention("nope", NOW).total).toBe(0);
  });

  it("shows workflow activity, newest first, without API key events or raw data", () => {
    const act = d.activity("A");
    expect(act.map((x) => x.type)).toEqual(["template.published", "file.signed", "file.email_failed", "file.email_failed"]);
    expect(act[0]).toMatchObject({ text: "Agreement published", subject: "Engagement Letter, version 1", fileId: null });
    expect(act[1]).toMatchObject({ text: "Client signed", fileId: ids.signed, actor: "client7@example.com" });
    expect(act[2].actor).toBe("Automatic");
    expect(JSON.stringify(act)).not.toMatch(/CRM sync|api_key|data_json|secret-token/);
  });

  it("recommends one next action from the real state", () => {
    const base = { admin: true, agreements: d.agreements("A"), hasCountersignature: true, hasFiles: true, attentionTotal: 0 };
    expect(d.nextAction({ ...base, agreements: [] })).toMatchObject({ title: "Upload your client agreement", href: "/app/agreements" });
    expect(d.nextAction({ ...base, admin: false, agreements: [] })).toMatchObject({ title: "Waiting on an admin to upload the client agreement" });
    expect(d.nextAction({ ...base, admin: false, agreements: [] }).href).toBeUndefined();
    const onlyDraft = d.agreements("A").filter((a) => a.name === "Retainer");
    expect(d.nextAction({ ...base, agreements: onlyDraft })).toMatchObject({ title: "Check the fields and publish", href: "/app/agreements/tvC1" });
    expect(d.nextAction({ ...base, hasCountersignature: false })).toMatchObject({ href: "/app/settings#countersign" });
    const a = d.attention("A", NOW);
    expect(d.nextAction({ ...base, top: a.items[0], attentionTotal: a.total })).toMatchObject({
      title: `Invitation email failed: ${a.items[0].clientName}`,
      href: `/app/files/${ids.failed}`,
      tone: "attention",
    });
    const sig = a.items.find((i) => i.reason === "countersign")!;
    expect(d.nextAction({ ...base, admin: false, top: sig, attentionTotal: 1 }).body).toContain("An admin needs to do this.");
    expect(d.nextAction({ ...base, hasFiles: false })).toMatchObject({ href: "/app/files/new", title: "Open your first client file" });
    expect(d.nextAction(base)).toMatchObject({ title: "Everything is on track", tone: "clear" });
  });
});
