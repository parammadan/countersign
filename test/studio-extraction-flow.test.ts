// The owner's regression end to end through the Studio service, against a real (temporary) database with a fake
// provider only (no network, no paid calls, no key): describe -> suggestion -> the form's values -> stored draft, and
// the clauses that draft states.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../lib/understand/model";
import type { DraftDocument } from "../lib/m23/m23-generate";
import * as X from "./support/studio-regression";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/app/studio-actions", () => ({ suggestAction: vi.fn(), createDraftAction: vi.fn() }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-studio-extract-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_DAILY_USD_CAP;
delete process.env.AI_ALLOW_UNVERIFIED_FOR_TESTS;

let db: typeof import("../lib/db");
let D: typeof import("../lib/drafts/service");
let UI: typeof import("../components/studio/NewAgreement");
const at = () => new Date().toISOString();
const owner = { userId: "u_ws_x", userEmail: "owner-ws_x@example.com", workspaceId: "ws_x", role: "owner" as const };

/** A fake model that answers `reply` and records what it was asked. */
function fake(reply: unknown) {
  const p = {
    asked: [] as { system: string; document: string; schema: unknown }[],
    provider: {
      name: "fake",
      model: "claude-opus-5-5",
      complete: async (r) => {
        p.asked.push({ system: r.system, document: r.document, schema: r.schema });
        r.onUsage?.({ inputTokens: 1_000, outputTokens: 100 });
        return reply;
      },
    } as ModelProvider,
  };
  return p;
}

beforeAll(async () => {
  db = await import("../lib/db");
  D = await import("../lib/drafts/service");
  UI = await import("../components/studio/NewAgreement");
  db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_x", "Firm X", "Firm X LLC", "Firm X", "Avery Tester", "avery-x@example.com", "inb_ws_x", at());
  db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", "u_ws_x", "owner-ws_x@example.com", "Avery Tester", "h", at(), at());
  db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_x", "u_ws_x", "owner", at());
});

/** What the form would send after the suggestion, untouched by the person. */
async function generateFromSuggestion(reply: unknown, fill: Record<string, string> = {}) {
  const p = fake(reply);
  const r = await D.suggestFromDescription(owner, X.REGRESSION, p.provider);
  if (!r.ok) throw new Error(r.code);
  const kinds = D.kindSpecs();
  const f = UI.suggestionToForm(r.suggestion, kinds, kinds[0]);
  const spec = kinds.find((k) => k.kind === f.kind)!;
  const terms = { ...f.terms, ...fill };
  const input = { kind: spec.kind, parties: spec.roles.map((role) => ({ role, name: f.names[role] ?? "" })), terms: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, spec.terms.find((t) => t.key === k)?.type === "int" ? Number(v) : v])) };
  const c = await D.createDraft(owner, input, null);
  return { p, suggestion: r.suggestion, c };
}

describe("regression through the Studio service", () => {
  it("the model gets the per-kind prompt and only the description; the stored draft states what was described", async () => {
    const { p, suggestion, c } = await generateFromSuggestion(X.NEW_ANSWER);
    expect(p.asked).toHaveLength(1);
    expect(p.asked[0].system).toBe(D.SUGGEST_SYSTEM);
    expect(JSON.parse(p.asked[0].document)).toEqual({ description: X.REGRESSION });
    expect(JSON.stringify(p.asked[0].schema)).toContain('"not_supported"');
    expect(suggestion.clarifications.optional.map((x) => x.key)).toEqual(["endDate", "paymentDays"]);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const g = D.getDraft(owner, c.draftId);
    if (!g.ok) throw new Error("draft not stored");
    const doc = g.version.doc as DraftDocument;
    const by = Object.fromEntries(doc.clauses.map((x) => [x.id, x.text]));
    expect(by.fees).toBe("The Client will pay the Consultant a one-time fixed fee of $12,000 for the services.");
    expect(by.ip).toContain("Each party keeps the intellectual property it owned before this Agreement.");
    expect(by.ip).toContain("Intellectual property that the Consultant creates in performing the services belongs to the Client.");
    expect(doc.clauses.map((x) => x.id)).toEqual(["parties", "scope", "term", "fees", "ip", "independent", "confidentiality", "termination", "liability", "governing_law", "signatures"]);
    expect(JSON.stringify(doc)).not.toMatch(/invoice/i);
    expect(doc.parties).toEqual([{ role: "Consultant", name: "Northwind Advisory LLC" }, { role: "Client", name: "Acme Widgets Inc" }]);
  });

  it("the old failure shape: nothing raw, nothing coerced; the person picks ownership and the draft is the plain fee", async () => {
    const { suggestion, c } = await generateFromSuggestion(X.OLD_ANSWER, { ipOwner: "Client" });
    expect(suggestion.terms).not.toHaveProperty("feePeriod");
    const shown = Object.values(suggestion.clarifications).flat().flatMap((x) => [x.label, x.text]).join("\n");
    expect(shown).not.toMatch(/feePeriod|ipOwner|paymentDays/);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const g = D.getDraft(owner, c.draftId);
    if (!g.ok) throw new Error("draft not stored");
    expect((g.version.doc as DraftDocument).clauses.find((x) => x.id === "fees")!.text).toBe("The Client will pay the Consultant a fee of $12,000 for the services.");
  });

  it("left untouched, the old shape's missing ownership is refused by Generate, in plain words", async () => {
    const { c } = await generateFromSuggestion(X.OLD_ANSWER);
    expect(c).toMatchObject({ ok: false, status: "needs_input" });
    if (c.ok) return;
    const { humanIssue } = await import("../lib/drafts/labels");
    expect(c.issues.map(humanIssue)).toEqual(["Missing: Who owns the work product"]);
  });
});
