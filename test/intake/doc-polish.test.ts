// Fixes from walking Document Intelligence in a browser, one focused check each (synthetic data, fake providers, no
// network): rules field names in plain words; a chosen file checked with the server's limits before it's sent; a
// paste the box accepted isn't refused for its CRLF line breaks; a document with no readable text is never sent to AI
// and gets no chat; long key-term values read as text; "Analyze again" sits in the analysis row; the draft page labels
// Claude's values with their form field.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelProvider } from "@/lib/understand/model";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doc-polish-"));
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/app/intake-actions", () => ({ readDocumentAction: vi.fn(), analyzeDocumentAction: vi.fn(), startDraftAction: vi.fn(), askDocumentAction: vi.fn() }));

import { aiOnlyValues, dateKindLabel, fieldText, reasonText } from "@/components/intake/labels";
import { fileProblem, LIMIT_MESSAGE, MAX_INTAKE_UPLOAD, MAX_PASTE_CHARS } from "@/lib/intake/limits";
import { DocumentAnalysis } from "@/components/intake/DocumentAnalysis";
import { DOC_AI_UNAVAILABLE } from "@/components/intake/ai-copy";
import type { DocAnalysis } from "@/lib/intake/ai";

const owner = { userId: "u_p_owner", userEmail: "owner-p@example.com", workspaceId: "ws_p", role: "owner" as const };

describe("Document Intelligence polish", () => {
  let db: typeof import("../../lib/db");
  let svc: typeof import("../../lib/intake/service");
  let ai: typeof import("../../lib/intake/ai-service");
  beforeAll(async () => {
    db = await import("../../lib/db");
    svc = await import("../../lib/intake/service");
    ai = await import("../../lib/intake/ai-service");
    const t = new Date(Date.now() - 30 * 86400_000).toISOString();
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", "ws_p", "Firm P", "Firm P LLC", "Firm P", "Avery Tester", "avery-p@example.com", "inb_p", t);
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES (?,?,?,?,?,?)", owner.userId, owner.userEmail, "Avery Tester", "x", t, t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", "ws_p", owner.userId, "owner", t);
  });

  it("the rules' field names and reasons read as plain words, never raw keys", () => {
    expect(reasonText("missing dates.effective_or_start")).toBe("Missing the effective or start date");
    expect(reasonText("missing parties (need two)")).toBe("Missing the two parties");
    expect(reasonText("conflicting values for amounts.fee")).toBe("Conflicting values for the fee");
    expect(reasonText("conflicting values for parties.Provider")).toBe("Conflicting values for the Provider's name");
    expect(reasonText("no extractable text (scanned or empty); OCR is out of scope")).toMatch(/^No extractable text/);
    expect(fieldText("governingLaw")).toBe("governing law");
    expect(fieldText("dates.invoice_date")).toBe("the invoice date");
    expect(dateKindLabel("effective")).toBe("Effective date");
    for (const r of ["missing governingLaw", "missing signatureBlocks", "missing amounts.rent", "conflicting values for dates.effective"]) expect(reasonText(r)).not.toMatch(/[a-z][A-Z]|\.\w|_/);
  });

  it("a chosen file is checked with the server's limits before it's sent (a too-large file would fail without its reason)", () => {
    expect(fileProblem({ name: "big.pdf", size: MAX_INTAKE_UPLOAD + 1 })).toBe(LIMIT_MESSAGE.tooLarge);
    expect(fileProblem({ name: "notes.txt", size: 10 })).toBe(LIMIT_MESSAGE.wrongType);
    expect(fileProblem({ name: "empty.pdf", size: 0 })).toBe(LIMIT_MESSAGE.empty);
    expect(fileProblem({ name: "Contract.PDF", size: 1000 })).toBeNull();
    expect(fileProblem({ name: "letter.docx", size: MAX_INTAKE_UPLOAD })).toBeNull();
  });

  it("the server gives the same messages", async () => {
    expect(await svc.runIntake(owner, { kind: "upload", data: Buffer.alloc(MAX_INTAKE_UPLOAD + 1, 1), filename: "big.pdf" })).toMatchObject({ message: LIMIT_MESSAGE.tooLarge });
    expect(await svc.runIntake(owner, { kind: "upload", data: Buffer.from("hello"), filename: "notes.txt" })).toMatchObject({ message: LIMIT_MESSAGE.wrongType });
  });

  it("a paste the box accepted isn't refused because the browser sent its line breaks as CRLF", async () => {
    const lines = Array.from({ length: 3_600 }, (_, i) => `${i + 1}. The Consultant will provide the services with due care.`);
    let text = lines.join("\n");
    text = text.slice(0, MAX_PASTE_CHARS - 10);
    expect(text.length).toBeLessThanOrEqual(MAX_PASTE_CHARS);
    const sent = text.replace(/\n/g, "\r\n");
    expect(sent.length).toBeGreaterThan(MAX_PASTE_CHARS);
    const r = await svc.runIntake(owner, { kind: "paste", text: sent });
    expect(r.ok).toBe(true);
    // a paste that really is too long is still refused
    expect(await svc.runIntake(owner, { kind: "paste", text: "x".repeat(MAX_PASTE_CHARS + 1) })).toMatchObject({ ok: false, code: "too_large" });
  });

  it("a document with no readable text is never sent to AI, and has no chat", async () => {
    const r = await svc.runIntake(owner, { kind: "paste", text: "   \f  \n " + "\f" + "\u200b" });
    // the rules may refuse blank pastes; store an empty upload-like result directly when they do
    let id: string;
    if (r.ok) id = r.id;
    else {
      const ok = await svc.runIntake(owner, { kind: "paste", text: "placeholder text" });
      if (!ok.ok) throw new Error("setup");
      id = ok.id;
      db.run("UPDATE intake_results SET model_pages_json = ?, model_ok = 1 WHERE id = ?", JSON.stringify(["", "  \n "]), id);
    }
    let calls = 0;
    const provider: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { calls++; return {}; } };
    expect(ai.documentAi(owner, id, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: (await import("../../lib/ai/anthropic")).TEST_KEY })).toEqual({ available: false, reason: "empty" });
    expect(await ai.analyzeIntake(owner, id, provider)).toMatchObject({ ok: false, code: "empty", message: expect.stringMatching(/no text we can read/) });
    expect(await ai.askIntakeQuestion(owner, id, "What is the fee?", null, provider, null)).toEqual({ ok: false, code: "empty" });
    expect(calls).toBe(0);
    expect(DOC_AI_UNAVAILABLE.empty).toMatch(/scanned image/);
  });

  it("key terms: a long value is its own line of text, not squeezed beside its label; Analyze again sits in the analysis row", () => {
    const long = "Unless an SOW states otherwise, Northwind will invoice monthly in arrears and each invoice is due within thirty (30) days.";
    const a: DocAnalysis = {
      schema: 1, model: "claude-opus-5-5", summary: [], worthChecking: [], disagreements: [], draft: null, warnings: [], truncated: false, pages: 1, ms: 1,
      findings: [{ id: "f1", topic: "payment", label: "Payment terms", value: long, status: "confirmed", ruleField: "none", evidence: [{ page: 1, quote: long }] }],
    };
    const h = renderToStaticMarkup(createElement(DocumentAnalysis, { analysis: a, createdAt: new Date().toISOString(), action: createElement("button", null, "Analyze again") }));
    expect(h).toMatch(new RegExp(`<p class="[^"]*break-words[^"]*">${long.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
    expect(h).not.toContain("text-right");
    expect(h).toContain("<button>Analyze again</button>");
  });

  it("the draft page lists Claude's values with their form field, and nothing when Claude added none", () => {
    const got = aiOnlyValues({ names: { Consultant: "Northwind Advisory LLC" }, terms: { noticeDays: "30", ipOwner: "Client" }, sources: [
      { key: "term:noticeDays", value: "30", page: 1, quote: "Either party may terminate on 30 days' written notice." },
      { key: "role:Consultant", value: "Northwind Advisory LLC", page: 1, quote: "Northwind Advisory LLC (\"Consultant\")" },
    ] });
    expect(got.map((x) => [x.label, x.value, x.source?.page ?? null])).toEqual([
      ["Consultant (legal name)", "Northwind Advisory LLC", 1],
      ["Notice period", "30", 1],
      ["Who owns the work product", "Client", null],
    ]);
    expect(aiOnlyValues({ names: {}, terms: {}, sources: [] })).toEqual([]);
    expect(aiOnlyValues(undefined)).toEqual([]);
  });
});
