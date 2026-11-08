// Document understanding storage: workspace isolation, the original left untouched, reviews, limits, and no
// document text in the audit trail. Hand-built database, synthetic agreement from fixtures/agreements.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-understand-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";

describe("document analyses", () => {
  let db: typeof import("../lib/db");
  let S: typeof import("../lib/understand/store");
  let files: typeof import("../lib/files");
  let vid = "";
  const pdfBytes = fs.readFileSync(path.join(process.cwd(), "fixtures/agreements/13-engagement-letter-filled-header.pdf"));

  function workspace(id: string) {
    db.run(
      "INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id, `Firm ${id}`, `Firm ${id} LLC`, `Firm ${id}`, "Avery Tester", `avery-${id}@example.com`, `inb_${id}`, new Date().toISOString(),
    );
  }

  beforeAll(async () => {
    db = await import("../lib/db");
    S = await import("../lib/understand/store");
    files = await import("../lib/files");
    const T = await import("../lib/templates");
    workspace("ws_a");
    workspace("ws_b");
    const { version } = await T.ingestAgreement(files.getWorkspace("ws_a"), { data: pdfBytes, filename: "engagement.pdf" }, { actor: "avery@example.com" });
    vid = version.id;
  });

  it("reads a version and stores checked findings, leaving the original as it was", async () => {
    const before = fs.readFileSync(path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`));
    const aid = await S.analyzeVersion("ws_a", vid, "avery@example.com");
    const v = S.latestAnalysis("ws_a", vid)!;
    expect(v.id).toBe(aid);
    expect(v.result.analyzer.kind).toBe("rules");
    expect(v.result.findings.length).toBeGreaterThan(5);
    for (const f of v.result.findings) if (f.status === "missing") expect(f.value).toBeNull();
    expect(fs.readFileSync(path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`)).equals(before)).toBe(true);
    const tv = db.one<{ fields_json: string; status: string }>("SELECT fields_json, status FROM template_versions WHERE id = ?", vid)!;
    expect(tv.status).toBe("draft");
  });

  it("another workspace can't read, run or review it", async () => {
    expect(() => S.latestAnalysis("ws_b", vid)).toThrow(files.AppError);
    await expect(S.analyzeVersion("ws_b", vid, "x@example.com")).rejects.toThrow(/not found/i);
    const v = S.latestAnalysis("ws_a", vid)!;
    expect(() => S.reviewFinding("ws_b", v.id, v.result.findings[0].id, "confirmed", "x@example.com")).toThrow(/not found/i);
  });

  it("confirm, dismiss and undo are recorded per finding; findings themselves never change", () => {
    const v = S.latestAnalysis("ws_a", vid)!;
    const [a, b] = v.result.findings;
    S.reviewFinding("ws_a", v.id, a.id, "confirmed", "avery@example.com");
    S.reviewFinding("ws_a", v.id, b.id, "dismissed", "avery@example.com");
    let r = S.latestAnalysis("ws_a", vid)!;
    expect(r.reviews[a.id]).toMatchObject({ decision: "confirmed", by: "avery@example.com" });
    expect(r.reviews[b.id].decision).toBe("dismissed");
    expect(r.result).toEqual(v.result);
    S.reviewFinding("ws_a", v.id, b.id, "undo", "avery@example.com");
    r = S.latestAnalysis("ws_a", vid)!;
    expect(r.reviews[b.id]).toBeUndefined();
    expect(() => S.reviewFinding("ws_a", v.id, "no-such-finding", "confirmed", "avery@example.com")).toThrow(/not found/i);
    expect(() => S.reviewFinding("ws_a", v.id, a.id, "approve" as never, "avery@example.com")).toThrow(/Unknown decision/);
  });

  it("reviews go to the latest reading only", async () => {
    const old = S.latestAnalysis("ws_a", vid)!;
    await S.analyzeVersion("ws_a", vid, "avery@example.com");
    const fresh = S.latestAnalysis("ws_a", vid)!;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.reviews).toEqual({});
    expect(() => S.reviewFinding("ws_a", old.id, old.result.findings[0].id, "confirmed", "avery@example.com")).toThrow(/read again/);
  });

  it("the audit trail records counts and labels, never document text", () => {
    const events = db.all<{ type: string; data_json: string }>("SELECT type, data_json FROM audit_events WHERE workspace_id = 'ws_a' AND type LIKE 'agreement.%'");
    expect(events.map((e) => e.type)).toContain("agreement.analyzed");
    const v = S.latestAnalysis("ws_a", vid)!;
    const text = events.map((e) => e.data_json).join("\n");
    for (const f of v.result.findings) for (const e of f.evidence) expect(text).not.toContain(e.quote);
  });

  it("a changed stored file isn't described", async () => {
    const p = path.join(dir, "blobs", `ws/ws_a/templates/${vid}/agreement.pdf`);
    const orig = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([orig, Buffer.from("\n%tampered")]));
    try {
      await expect(S.analyzeVersion("ws_a", vid, "avery@example.com")).rejects.toThrow(/fingerprint/);
    } finally {
      fs.writeFileSync(p, orig);
    }
  });

  it("runs per workspace are limited", async () => {
    const n = db.one<{ n: number }>("SELECT COUNT(*) n FROM document_analyses WHERE workspace_id = 'ws_a'")!.n;
    const row = db.one<{ result_json: string }>("SELECT result_json FROM document_analyses LIMIT 1")!;
    for (let i = n; i < S.RUNS_PER_HOUR; i++)
      db.run("INSERT INTO document_analyses (id, workspace_id, template_version_id, source_sha256, analyzer, result_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)", `an_fill${i}`, "ws_a", vid, "x", "rules", row.result_json, "t", new Date().toISOString());
    await expect(S.analyzeVersion("ws_a", vid, "avery@example.com")).rejects.toThrow(/limit/);
  });

  it("failed attempts count against the limit too, before any work is done", async () => {
    workspace("ws_c");
    db.run("INSERT INTO templates (id, workspace_id, name, created_at) VALUES ('tpl_c', 'ws_c', 'C', ?)", new Date().toISOString());
    const add = (id: string, pages: number) =>
      db.run(
        "INSERT INTO template_versions (id, template_id, workspace_id, version, source_name, source_path, pdf_path, sha256, pages_json, fields_json, detection_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, "tpl_c", "ws_c", 1, "a.pdf", "missing", "missing/agreement.pdf", "0", JSON.stringify(Array.from({ length: pages }, () => ({ width: 612, height: 792 }))), "[]", "{}", "draft", new Date().toISOString(),
      );
    add("tv_big", S.MAX_PAGES + 1);
    // refused from the stored page count, without reading or extracting the file (it doesn't even exist)
    await expect(S.analyzeVersion("ws_c", "tv_big", "c@example.com")).rejects.toThrow(/more than 200 pages/);
    for (let i = 1; i < S.RUNS_PER_HOUR; i++) await expect(S.analyzeVersion("ws_c", "tv_big", "c@example.com")).rejects.toThrow(/pages/);
    await expect(S.analyzeVersion("ws_c", "tv_big", "c@example.com")).rejects.toThrow(/limit/);
    expect(db.one<{ n: number }>("SELECT COUNT(*) n FROM document_analyses WHERE workspace_id = 'ws_c'")!.n).toBe(0);
  });
});
