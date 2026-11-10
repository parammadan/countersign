// Re-review of #63 (91d2039): hostile text matrices in uploaded PDFs (huge font scale; overflowing numbers that
// pdfjs reads as NaN) must not make line grouping slow, and their text is still read; governing-law dedupe is
// linear; a table created by an earlier build gains the new intake columns. Synthetic data only.
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractPdf } from "../../lib/pdf/extract";
import { pagesFromExtraction } from "../../lib/intake/pages";
import { analyzeDocument } from "../../lib/intake/intake";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-intake-hostile-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

/** A minimal one-page PDF with a raw content stream (so the text matrix can be anything). */
function rawPdf(content: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const HUGE = Array.from({ length: 200 }, (_, i) => `BT /F1 1 Tf 10000000 0 0 10000000 ${i} 10 Tm (x${i}) Tj ET`).join("\n");
const OVERFLOW = "1" + "0".repeat(320);
const NAN = Array.from({ length: 2_000 }, (_, i) => `BT /F1 1 Tf 1 0 0 1 ${OVERFLOW} ${OVERFLOW} Tm (n${i}) Tj ET`).join("\n");

describe("hostile PDF text matrices", () => {
  it("defence (R1): a huge font scale does not widen line grouping; the text is still read", async () => {
    const ex = await extractPdf(new Uint8Array(rawPdf(HUGE)));
    const t = Date.now();
    const pages = pagesFromExtraction(ex);
    expect(Date.now() - t).toBeLessThan(1_500);
    expect(pages[0].replace(/\s/g, "")).toMatch(/^x+/); // pdfjs places the glyphs of a 1e7-scale run far apart; they are still read
    // synthetic: 20,000 items with h = 1e7 on distinct baselines
    const items = Array.from({ length: 20_000 }, (_, i) => ({ str: `y${i}`, x: i, y: i * 1e7, w: 1, h: 1e7, size: 1e7 }));
    const t2 = Date.now();
    pagesFromExtraction({ pages: [{ index: 0, width: 612, height: 792, items, hlines: [], boxes: [] }], textChars: 0 });
    expect(Date.now() - t2).toBeLessThan(1_500);
  });

  it("defence (R2): non-finite coordinates (an overflowing Tm) are not grouped into one row; each item is kept on its own line", async () => {
    const ex = await extractPdf(new Uint8Array(rawPdf(NAN)));
    const t = Date.now();
    const pages = pagesFromExtraction(ex);
    expect(Date.now() - t).toBeLessThan(1_500);
    // pdfjs gives each glyph its own NaN-positioned item: every one is kept, on a line of its own
    expect(pages[0].split("\n").filter((l) => l === "n")).toHaveLength(2_000);
    const items = Array.from({ length: 20_000 }, (_, i) => ({ str: `z${i}`, x: NaN, y: NaN, w: NaN, h: NaN, size: NaN }));
    const t2 = Date.now();
    const out = pagesFromExtraction({ pages: [{ index: 0, width: 612, height: 792, items, hlines: [], boxes: [] }], textChars: 0 });
    expect(Date.now() - t2).toBeLessThan(1_500);
    expect(out[0].split("\n")).toHaveLength(20_000);
  });

  describe("through the upload path", () => {
    let svc: typeof import("../../lib/intake/service");
    beforeAll(async () => {
      const db = await import("../../lib/db");
      svc = await import("../../lib/intake/service");
      const t = new Date().toISOString();
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_h','h','h LLC','h','Avery Tester','a@example.com','inb_h',?)", t);
      db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u_h','h@example.com','h','x',?)", t);
      db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_h','u_h','staff',?)", t);
    });
    it("defence (R1, R2): both hostile PDFs are read in bounded time", async () => {
      const s = { userId: "u_h", workspaceId: "ws_h", role: "staff" as const };
      for (const content of [HUGE, NAN]) {
        const t = Date.now();
        const r = await svc.runIntake(s, { kind: "upload", data: rawPdf(content), filename: "hostile.pdf" });
        expect(Date.now() - t).toBeLessThan(10_000);
        expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
      }
    });
  });

  it("governing-law dedupe is linear: many distinct places read quickly and are capped", () => {
    const name = (i: number) => "Q" + i.toString(26).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]).replace(/[a-p]/g, (c) => c);
    const lines: string[] = [];
    for (let i = 0, n = 0; n < 150_000; i++) { const l = `This Agreement is governed by the laws of ${name(i)}.`; lines.push(l); n += l.length + 1; }
    const t = Date.now();
    const r = analyzeDocument({ pages: [lines.join("\n")] });
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(r.governingLaw.length).toBe(50);
    expect(r.routing.decision).not.toBe("ready_to_prepare");
  });

  it("a table created by an earlier build gains the new columns, idempotently, keeping its rows", async () => {
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE intake_results (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      source TEXT NOT NULL, filename TEXT, doc_type TEXT NOT NULL, decision TEXT NOT NULL, text_sha256 TEXT NOT NULL, record_json TEXT NOT NULL);
      INSERT INTO intake_results VALUES ('int_old','ws','u','2026-01-01','paste',NULL,'other','unsupported','h','{}');`);
    const { ensureIntakeSchema } = await import("../../lib/intake/store");
    ensureIntakeSchema(old);
    const again = new DatabaseSync(file);
    ensureIntakeSchema(again);
    const cols = (again.prepare("PRAGMA table_info(intake_results)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["confirmed_by", "confirmed_at", "draft_id"]));
    expect(again.prepare("SELECT id, draft_id FROM intake_results").all().map((r) => ({ ...r }))).toEqual([{ id: "int_old", draft_id: null }]);
    old.close();
    again.close();
  });
});
