// Document Intelligence's screens, server-rendered with the router and the server actions stubbed (nothing is called):
// the upload form offers "Analyze with AI" only when AI would run and always offers the synthetic sample; the analysis
// shows each point with its quote and page, the three kinds of "worth checking", disagreements with the rules and the
// not-legal-advice label; the Studio form marks Claude's values and lists what the template can't include. No network.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doc-ai-ui-"));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/app/intake-actions", () => ({ readDocumentAction: vi.fn(), analyzeDocumentAction: vi.fn(), startDraftAction: vi.fn(), askDocumentAction: vi.fn() }));
vi.mock("@/app/studio-actions", () => ({ suggestAction: vi.fn(), createDraftAction: vi.fn() }));

import { ReadDocument } from "@/components/intake/ReadDocument";
import { DocumentAnalysis } from "@/components/intake/DocumentAnalysis";
import { DraftFromIntake } from "@/components/intake/DraftFromIntake";
import { CHAT_EXAMPLES, DOC_AI_COPY, DOC_AI_UNAVAILABLE } from "@/components/intake/ai-copy";
import { SAMPLE_AGREEMENT, SAMPLE_TITLE } from "@/lib/intake/sample";
import type { DocAnalysis } from "@/lib/intake/ai";
import type { KindSpec } from "@/lib/drafts/service";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("Document Intelligence screens", () => {
  it("the upload form: Analyze with AI only when AI is on, rules-only reading otherwise, the sample always", () => {
    const on = renderToStaticMarkup(createElement(ReadDocument, { aiOn: true }));
    expect(on).toContain(DOC_AI_COPY.analyze);
    expect(on).toContain(DOC_AI_COPY.sample);
    expect(on).toContain('aria-label="Document file"');
    expect(on).toContain('aria-label="Document text"');
    expect(on).toContain('role="status"');
    const off = renderToStaticMarkup(createElement(ReadDocument, { aiOn: false }));
    expect(off).not.toContain(DOC_AI_COPY.analyze);
    expect(off).toContain(DOC_AI_COPY.rulesOnly);
    expect(off).toContain(DOC_AI_COPY.sample);
  });

  it("the sample is explicitly labelled synthetic, with fictional parties and example.com addresses only", () => {
    expect(SAMPLE_TITLE).toBe("Sample (synthetic) agreement");
    expect(SAMPLE_AGREEMENT).toMatch(/^SAMPLE \(SYNTHETIC\) AGREEMENT: fictional parties/);
    for (const m of SAMPLE_AGREEMENT.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(m[1]).toMatch(/(^|\.)example\.com$/);
  });

  it("fixed copy: the scope line, the not-legal-advice label, the chat examples and every unavailable reason", () => {
    expect(DOC_AI_COPY.heading).toBe("Understand any document with AI");
    expect(DOC_AI_COPY.intro).toBe("Upload a document to understand its terms, ask questions, and prepare an agreement draft.");
    expect(DOC_AI_COPY.scope).toBe("This page: one document. Knowledge Hub: questions across all your agreements.");
    expect(DOC_AI_COPY.disclaimer).toBe("Informational, not legal advice");
    expect(CHAT_EXAMPLES).toEqual(["Explain this agreement in simple English.", "Can either party terminate early?", "Who owns the work product?", "What happens if payment is late?"]);
    expect(Object.keys(DOC_AI_UNAVAILABLE).sort()).toEqual(["empty", "no_text", "off", "scan_incomplete", "spend_cap", "unverified"]);
  });

  it("the analysis: quotes with pages, statuses, worth checking by kind, disagreements, disclaimer", () => {
    const a: DocAnalysis = {
      schema: 1,
      model: "claude-opus-5-5",
      summary: [{ text: "This is a consulting agreement.", evidence: [{ page: 1, quote: "This Consulting Agreement is entered into" }] }],
      findings: [
        { id: "f1", topic: "amounts", label: "Fee", value: "$12,000", status: "confirmed", ruleField: "fee", evidence: [{ page: 1, quote: "a fixed fee of $12,000" }] },
        { id: "f2", topic: "amounts", label: "Retainer", value: "$15,000 per month", status: "unconfirmed", note: "The quoted text doesn't contain $15,000.", ruleField: "none", evidence: [{ page: 1, quote: "a fixed fee of $12,000" }] },
      ],
      worthChecking: [
        { kind: "missing", topic: "other", label: "Insurance", text: "", evidence: [] },
        { kind: "ambiguous", topic: "payment", label: "Late interest", text: "Check what the interest applies to.", evidence: [{ page: 1, quote: "Late payments accrue interest at 1.5% per month." }] },
        { kind: "conflicting", topic: "amounts", label: "Two fees", text: "", evidence: [{ page: 1, quote: "a fee of $4,500" }, { page: 2, quote: "The fee is $5,400" }] },
      ],
      disagreements: [{ field: "governing_law", label: "Governing law", ai: ["New York"], rules: [{ page: 2, quote: "State of Vermont" }] }],
      draft: null,
      warnings: ["1 point Claude made couldn't be found in the document's text and was removed."],
      truncated: false,
      pages: 2,
      ms: 10,
    };
    const h = renderToStaticMarkup(createElement(DocumentAnalysis, { analysis: a, createdAt: new Date().toISOString() }));
    expect(h).toContain("In plain English");
    expect(h).toContain("p. 1");
    expect(h).toContain(">a fixed fee of $12,000</span>");
    expect(h).toContain("Quoted");
    expect(h).toContain("Not confirmed");
    for (const t of ["Not found in the document", "Unclear wording", "Passages that may conflict"]) expect(h).toContain(t);
    expect(h).toContain("Claude and the rules read these differently");
    expect(h).toContain("State of Vermont");
    expect(h).toContain(DOC_AI_COPY.disclaimer);
    expect(h).toContain(esc(a.warnings[0]));
  });

  it("the Studio form from a document: Claude's values marked, rules' values marked, what the template can't include listed", () => {
    const kinds: KindSpec[] = [
      { kind: "consulting", title: "Consulting Agreement", roles: ["Consultant", "Client"], terms: [{ key: "fee", type: "money", required: true }, { key: "noticeDays", type: "int", required: true }, { key: "paymentDays", type: "int", required: false }] },
    ];
    const h = renderToStaticMarkup(
      createElement(DraftFromIntake, {
        intakeId: "int_x",
        kinds,
        initial: {
          kind: "consulting",
          names: { Consultant: "Northwind Advisory LLC" },
          terms: { fee: "$12,000", noticeDays: "30" },
          notes: [],
          ai: { names: {}, terms: { noticeDays: "30" } },
          clarifications: { needed: [{ key: "party:Client", label: "Client's legal name", text: "" }], optional: [{ key: "paymentDays", label: "Invoice payment timing", text: "You can add this, or leave it out." }], unsupported: [{ key: "other", label: "Other", text: "The document has a 12-month non-solicitation clause." }] },
        },
      }),
    );
    expect(h).toContain("Consultant (legal name) (from the document)");
    expect(h).toContain("Fee (with currency, e.g. $5,000) (from the document)");
    expect(h).toContain("Notice period (days) (from the document, read by AI: check it)");
    expect(h).toContain("In the document, but this template can&#x27;t include it");
    expect(h).toContain("non-solicitation");
    expect(h).toContain("Needed before you can generate");
    expect(h).toContain("I checked these values against the document.");
  });
});
