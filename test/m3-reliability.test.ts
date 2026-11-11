// M3 Knowledge Hub reliability: duplicate citations from identical agreements, answers whose agreement has since
// changed, and paging through many answers. Synthetic PDFs, no provider, no network.
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-m3rel-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

async function pdf(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  lines.forEach((l, i) => p.drawText(l, { x: 60, y: 720 - i * 18, size: 11, font: f }));
  return Buffer.from(await d.save());
}
const LINES = [
  "Consulting Agreement between Northwind Example LLC and the Client.",
  "1. Fees. The Client pays a monthly retainer of $4,500.",
  "2. Payment. Invoices are due within 30 days of receipt.",
  "Client signature: ____________________",
];
type Sess = { userId: string; userEmail: string; workspaceId: string; role: "owner" | "admin" | "staff" };
const owner: Sess = { userId: "u_owner", userEmail: "owner@example.com", workspaceId: "ws_r", role: "owner" };

describe("M3 reliability", () => {
  let db: typeof import("../lib/db");
  let S: typeof import("../lib/m3/store");
  let T: typeof import("../lib/templates");
  let files: typeof import("../lib/files");
  let n = 0;
  const ask = async (q: string) => {
    const id = await S.askAcrossAgreements({ ...owner, userId: `u_${++n}` }, q, null);
    return S.recentQuestions(owner, 50).find((e) => e.id === id)!;
  };
  const upload = async (name: string, lines: string[], templateId?: string) => {
    const r = await T.ingestAgreement(files.getWorkspace("ws_r"), { data: await pdf(lines), filename: `${name}.pdf` }, { actor: "owner@example.com", templateId });
    return { templateId: r.template.id, versionId: r.version.id };
  };

  beforeAll(async () => {
    db = await import("../lib/db");
    S = await import("../lib/m3/store");
    T = await import("../lib/templates");
    files = await import("../lib/files");
    const t = new Date().toISOString();
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_r", "Firm", "Firm LLC", "Firm", "Avery Tester", "avery@example.com", "inb_r", t);
  });

  it("a re-uploaded copy of an agreement doesn't make the same citation appear twice", async () => {
    await upload("consulting", LINES);
    await upload("consulting", LINES);
    await S.runIndex(owner);
    const h = await ask("When are invoices due?");
    const keys = h.result.citations.map((c) => `${c.agreement}|${c.page}|${c.quote}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(h.result.citations.map((c) => c.n)).toEqual(keys.map((_, i) => i + 1));
  });
});
