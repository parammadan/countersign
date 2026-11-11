// The Knowledge Hub's suggested questions find cited passages (no model) in the in-app sample agreement, and in the
// fixture agreements, each indexed in its own workspace. No network, no paid calls.
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-m3ex-"));
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;

const SETS: Record<string, string[]> = {
  sample: ["public/samples/sample-client-agreement.pdf"],
  fixtures: fs.readdirSync("fixtures/agreements").filter((f) => f.endsWith(".pdf")).map((f) => `fixtures/agreements/${f}`),
};

describe("Knowledge Hub example questions", () => {
  let S: typeof import("../lib/m3/store");
  let EX: typeof import("../lib/m3/examples");
  const sess = (ws: string) => ({ userId: `u_${ws}`, userEmail: `${ws}@example.com`, workspaceId: ws, role: "owner" as const });

  beforeAll(async () => {
    const db = await import("../lib/db");
    const T = await import("../lib/templates");
    const files = await import("../lib/files");
    S = await import("../lib/m3/store");
    EX = await import("../lib/m3/examples");
    const t = new Date().toISOString();
    for (const [ws, list] of Object.entries(SETS)) {
      db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", ws, "Firm", "Firm LLC", "Firm", "Avery Tester", `${ws}@example.com`, `inb_${ws}`, t);
      db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", `u_${ws}`, `${ws}@example.com`, "Owner", "h", t, t);
      db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", ws, `u_${ws}`, "owner", t);
      for (const f of list) await T.ingestAgreement(files.getWorkspace(ws), { data: fs.readFileSync(f), filename: path.basename(f) }, { actor: `${ws}@example.com` });
      await S.runIndex(sess(ws));
    }
  }, 120_000);

  for (const ws of Object.keys(SETS))
    it(`each one finds cited passages in the ${ws} agreements`, async () => {
      let n = 0;
      for (const q of EX.KNOWLEDGE_EXAMPLES) {
        await S.askAcrossAgreements({ ...sess(ws), userId: `u_${ws}-${++n}` }, q, null);
        const r = S.recentQuestions(sess(ws))[0].result;
        expect(r.status, q).not.toBe("not_found");
        expect(r.citations.length, q).toBeGreaterThan(0);
      }
    }, 60_000);
});
