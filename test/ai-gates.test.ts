// The Knowledge Hub and Agreement Studio under the server-wide spending limit and the email-confirmation rule, against
// a real (temporary) database with counting fake providers only: the Knowledge Hub answers from the passages and says
// why when the limit is reached or the workspace is unconfirmed (the provider is never called); Agreement Studio says
// when a draft is the plain template although AI was meant to reword it. No network, no paid calls. (Q&A is wired to
// the limit separately.)
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ModelProvider } from "../lib/understand/model";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ai-gates-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
delete process.env.AI_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_DAILY_USD_CAP;
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

let db: typeof import("../lib/db");
let B: typeof import("../lib/ai/budget");
let K: typeof import("../lib/m3/store");
let D: typeof import("../lib/drafts/service");
let n = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();
const owner = { userId: "u_ws_a", userEmail: "owner-ws_a@example.com", workspaceId: "ws_a", role: "owner" as const };
const nda = {
  kind: "nda" as const,
  parties: [{ role: "Disclosing Party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "Acme Widgets Inc" }],
  terms: { startDate: "2027-02-01", confidentialityYears: 3, governingLaw: "Delaware" },
};

/** A provider that counts its calls; `answer` builds its reply from the request. */
function counting(answer: (doc: string) => unknown = () => ({}), delayMs = 0) {
  const p = {
    calls: 0,
    provider: {
      name: "fake",
      model: "claude-opus-5-5",
      complete: async (r) => {
        p.calls++;
        if (delayMs) await wait(delayMs);
        r.onUsage?.({ inputTokens: 1_000, outputTokens: 100 });
        return answer(r.document);
      },
    } as ModelProvider,
  };
  return p;
}
const askAll = async (q: string, p: ModelProvider | null) => {
  const qid = await K.askAcrossAgreements({ ...owner, userId: `u_m3_${++n}` }, q, p);
  return K.recentQuestions(owner).find((h) => h.id === qid)!;
};
const confirmationOn = () => {
  process.env.SMTP_USER = "test@example.com";
  process.env.SMTP_PASS = "pw"; // dummy: email "can leave the server", so confirmation is required
};

async function pdf(lines: string[]): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  lines.forEach((l, i) => p.drawText(l, { x: 60, y: 720 - i * 18, size: 11, font: f }));
  return Buffer.from(await d.save());
}

beforeAll(async () => {
  db = await import("../lib/db");
  B = await import("../lib/ai/budget");
  K = await import("../lib/m3/store");
  D = await import("../lib/drafts/service");
  const files = await import("../lib/files");
  const T = await import("../lib/templates");
  for (const ws of ["ws_a", "ws_h"]) {
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES (?,?,?,?,?,?,?,?)", ws, `Firm ${ws}`, `Firm ${ws} LLC`, `Firm ${ws}`, "Avery Tester", `avery-${ws}@example.com`, `inb_${ws}`, at());
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", `u_${ws}`, `owner-${ws}@example.com`, "Avery Tester", "h", at());
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)", ws, `u_${ws}`, "owner", at());
  }
  const ws = files.getWorkspace("ws_a");
  await T.ingestAgreement(ws, { data: await pdf(["Consulting Agreement between Northwind Example LLC and the Client.", "2. Payment. Invoices are due within 30 days of receipt.", "Client signature: ____________________"]), filename: "consulting.pdf" }, { actor: "owner@example.com" });
  await K.runIndex(owner);
});

afterEach(() => {
  delete process.env.AI_DAILY_USD_CAP;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  B.spentUsd();
  db.run("DELETE FROM ai_spend");
});

describe("Knowledge Hub (M3)", () => {
  const notFound = () => ({ status: "not_found", answer: "n/a", citations: [] });

  it("within the limit, the model is asked and its cost is booked", async () => {
    const p = counting(notFound);
    const h = await askAll("When are invoices due?", p.provider);
    expect(p.calls).toBe(1);
    expect(h.result.mode).toBe("model");
    expect(db.one<{ feature: string }>("SELECT feature FROM ai_spend")!.feature).toBe("m3");
  });

  it("at the limit, the provider isn't called: passages only, and the person is told why", async () => {
    process.env.AI_DAILY_USD_CAP = "0";
    const p = counting(notFound);
    const h = await askAll("When are invoices due?", p.provider);
    expect(p.calls).toBe(0);
    expect(h.result.mode).toBe("passages");
    expect(h.result.warnings[0]).toBe(B.MESSAGES.spendCap);
    expect(K.assistantMode(p.provider, "ws_a")).toEqual({ kind: "passages", notice: B.MESSAGES.spendCap });
  });

  it("two concurrent questions with room for one: one model answer, one passages answer saying why", async () => {
    // room for one reservation (each is at least $0.084 for the 4,000-token output cap) but not two
    process.env.AI_DAILY_USD_CAP = "0.16";
    const p = counting(notFound, 30);
    const [a, b] = await Promise.all([askAll("When are invoices due?", p.provider), askAll("When is payment due?", p.provider)]);
    expect(p.calls).toBe(1);
    expect([a.result.mode, b.result.mode].sort()).toEqual(["model", "passages"]);
    expect((a.result.mode === "passages" ? a : b).result.warnings[0]).toBe(B.MESSAGES.spendCap);
    expect(B.spentUsd()).toBeLessThanOrEqual(0.16);
  });

  it("an unconfirmed workspace never reaches the provider and is asked to confirm", async () => {
    confirmationOn();
    const p = counting(notFound);
    const h = await askAll("When are invoices due?", p.provider);
    expect(p.calls).toBe(0);
    expect(h.result.warnings[0]).toBe(B.MESSAGES.unverified);
  });
});

describe("Agreement Studio (M2.3)", () => {
  it("without a provider the draft is the template, as before, with no fallback notice", async () => {
    const r = await D.createDraft(owner, nda, null);
    expect(r).toMatchObject({ ok: true, source: "template", landing: "template" });
    expect(r.ok && "fallback" in r).toBe(false);
  });

  it("at the limit, the provider isn't called and the draft says AI didn't run", async () => {
    process.env.AI_DAILY_USD_CAP = "0";
    const p = counting();
    const r = await D.createDraft(owner, nda, p.provider);
    expect(p.calls).toBe(0);
    expect(r).toMatchObject({ ok: true, source: "template", landing: "template_fallback", fallback: "spend_cap" });
    expect(await D.suggestFromDescription(owner, "An NDA between Northwind Advisory LLC and Acme Widgets Inc.", p.provider)).toEqual({ ok: false, code: "spend_cap" });
    expect(p.calls).toBe(0);
  });

  it("an unconfirmed workspace never reaches the provider", async () => {
    confirmationOn();
    const p = counting();
    expect(await D.createDraft(owner, nda, p.provider)).toMatchObject({ ok: true, landing: "template_fallback", fallback: "unverified" });
    expect(await D.suggestFromDescription(owner, "An NDA between Northwind Advisory LLC and Acme Widgets Inc.", p.provider)).toEqual({ ok: false, code: "unverified" });
    expect(p.calls).toBe(0);
  });

  it("a provider error or rejected wording is reported, not passed off as a plain template draft", async () => {
    const broken: ModelProvider = { name: "fake", model: "claude-opus-5-5", complete: async () => { throw new Error("upstream 529"); } };
    expect(await D.createDraft(owner, nda, broken)).toMatchObject({ ok: true, source: "template", landing: "template_fallback", fallback: "provider_error" });
    const p = counting(() => ({ nonsense: true }));
    expect(await D.createDraft(owner, nda, p.provider)).toMatchObject({ ok: true, source: "template", landing: "template_fallback", fallback: "checks" });
    expect(p.calls).toBe(1);
  });

  it("two concurrent drafts with room for one: the second is refused at the call and says so", async () => {
    const probe = counting(() => ({ nonsense: true }));
    await D.createDraft(owner, nda, probe.provider);
    const one = db.one<{ usd: number }>("SELECT reserved_usd usd FROM ai_spend WHERE feature = 'studio_draft'")!.usd;
    db.run("DELETE FROM ai_spend");
    const cap = one * 1.5;
    expect(cap).toBeGreaterThanOrEqual(B.estimateUsd(10_000, 4_000)); // both pass the up-front check; only one fits
    process.env.AI_DAILY_USD_CAP = String(cap);
    const p = counting(() => ({ nonsense: true }), 30);
    const [a, b] = await Promise.all([D.createDraft(owner, nda, p.provider), D.createDraft(owner, nda, p.provider)]);
    expect(p.calls).toBe(1);
    expect([a.ok && a.fallback, b.ok && b.fallback].sort()).toEqual(["checks", "spend_cap"]);
    expect(B.spentUsd()).toBeLessThanOrEqual(cap);
  });

  it("over the hourly allowance, the draft says AI didn't run", async () => {
    const p = counting(() => ({ nonsense: true }));
    const s = { ...owner, userId: "u_ws_h", workspaceId: "ws_h", userEmail: "owner-ws_h@example.com" };
    for (let i = 0; i < 30; i++) await D.createDraft(s, nda, p.provider);
    expect(p.calls).toBe(30);
    expect(await D.createDraft(s, nda, p.provider)).toMatchObject({ ok: true, landing: "template_fallback", fallback: "hourly_limit" });
    expect(p.calls).toBe(30);
  });

  it("the draft page's notice names the reason in fixed text", () => {
    expect(D.fallbackNotice("spend_cap")).toBe("AI rewording didn't run (AI isn't available right now: daily limit), so this draft is the template with exactly your values.");
    expect(D.fallbackNotice("unverified")).toMatch(/^AI rewording didn't run \(confirm your email address/);
    expect(D.fallbackNotice("checks")).toMatch(/^AI rewording was discarded/);
    expect(D.fallbackNotice("<script>")).toBe("AI rewording didn't run (it wasn't available), so this draft is the template with exactly your values.");
    expect(D.fallbackNotice(undefined)).toMatch(/it wasn't available/);
  });
});
