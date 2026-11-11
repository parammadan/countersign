// Email-delivery guidance: one shared copy, shown on every screen where someone waits for an email, and a
// "sent" status always reads as the mail server accepting it, never as delivered to the inbox.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-email-guidance-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
// an SMTP mail server that accepts everything (a stand-in transport; nothing leaves the test)
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = ["pw", process.pid, Date.now()].join("-");
(globalThis as unknown as { __csmailer: unknown }).__csmailer = { sendMail: async () => ({ messageId: "<accepted@test>" }) };

const sess = { userId: "usr_g", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_g", role: "owner" as const };
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("../lib/auth")>()), getSession: async () => sess, requireSession: async () => sess, requireAdmin: async () => sess }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/font/google", () => ({ Dancing_Script: () => ({ style: { fontFamily: "script" } }), Caveat: () => ({ style: { fontFamily: "hand" } }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

import { CLIENT_INVITE_KINDS, EMAIL_HELP } from "@/lib/email-guidance";

// React escapes ' and " in text
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const has = (html: string, copy: string) => expect(html).toContain(esc(copy));
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("the shared copy", () => {
  it("says exactly what was asked, and never claims inbox delivery", () => {
    expect(EMAIL_HELP.verify).toBe("Check your inbox for a verification link. If you don't see it in a few minutes, check Spam or Junk and mark it as Not spam.");
    expect(EMAIL_HELP.client).toBe("Your client may need to check their Spam or Junk folder for the signing invitation.");
    expect(EMAIL_HELP.otp).toBe("The code can take a minute to arrive. If you don't see it, check Spam or Junk.");
    expect(EMAIL_HELP.sent).toBe("Sent (accepted by the mail server)");
    expect(JSON.stringify(EMAIL_HELP)).not.toMatch(/\bdelivered\b/i);
    expect(CLIENT_INVITE_KINDS).toEqual(["invite", "resend", "reminder"]);
  });
});

describe("screens", () => {
  let db: typeof import("../lib/db");
  let files: typeof import("../lib/files");
  let fileId = "";
  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES ('usr_g','avery@example.com','Avery Tester','x',?,?)", t, t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, require_otp, created_at) VALUES ('ws_g','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_g',1,?)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_g','usr_g','owner',?)", t);
    const ws = files.getWorkspace("ws_g");
    const tpl = await import("../lib/templates");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
    const f = await files.createFile(ws, { clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, { kind: "system", label: "test" }, {});
    fileId = f.id;
    expect(db.one<{ status: string }>("SELECT status FROM emails WHERE file_id = ?", f.id)!.status).toBe("sent");
  });

  it("sign-up / unverified: the banner on every app page has the guidance and a Resend link button", async () => {
    const { UnverifiedBanner, VerifyEmailHelp } = await import("@/components/VerifyEmailForms");
    const h = renderToStaticMarkup(createElement(UnverifiedBanner, { email: "avery@example.com" }));
    expect(h).toContain("We sent a link to avery@example.com");
    has(h, EMAIL_HELP.verify);
    expect(h).toMatch(/<button[^>]*>Resend link<\/button>/);
    has(renderToStaticMarkup(createElement(VerifyEmailHelp)), EMAIL_HELP.verify);
    // the app layout shows it whenever the owner hasn't confirmed; the confirm-email page offers it when its link fails
    expect(src("app/app/layout.tsx")).toContain("<UnverifiedBanner");
    expect(src("components/VerifyEmailForms.tsx")).toMatch(/st\?\.error && <VerifyEmailHelp \/>/);
  });

  it("the AI notices for an unconfirmed email repeat the guidance and point to Resend link", async () => {
    const { ExploreAi } = await import("@/components/ExploreAi");
    const h = renderToStaticMarkup(createElement(ExploreAi, { ai: { available: false, reason: "unverified" }, askHref: null, verifyHelp: true }));
    has(h, EMAIL_HELP.verify);
    has(h, EMAIL_HELP.resendAbove);
    // no confirmation email can be sent (no provider, verifyHelp false): nothing about an inbox
    expect(renderToStaticMarkup(createElement(ExploreAi, { ai: { available: false, reason: "unverified" }, askHref: null }))).not.toContain("Spam");
    expect(src("app/app/agreements/[id]/ask/page.tsx")).toContain("${EMAIL_HELP.verify} ${EMAIL_HELP.resendAbove}");
  });

  it("the file page: the client spam hint after sending, and the invitation labelled as accepted, not delivered", async () => {
    const { default: Page } = await import("../app/app/files/[id]/page");
    const h = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: fileId }), searchParams: Promise.resolve({ created: "1" }) }));
    has(h, EMAIL_HELP.client);
    expect(h).toContain(esc(EMAIL_HELP.sent));
    expect(h).not.toMatch(/>Delivered</);
    expect(h).not.toContain("Delivered to the mail server");
  });

  it("the resend and reminder actions add the client hint to their result, except when email is only logged", () => {
    const s = src("components/FileActions.tsx");
    expect(s).toContain("{!outbox && op && SENDS_INVITE.includes(op) && <> {EMAIL_HELP.client}</>}");
    expect(s).toContain('const SENDS_INVITE = ["send", "resend", "remind"];');
  });

  it("the email log: accepted-by-the-mail-server labels and the client hint, list and detail", async () => {
    const { default: List } = await import("../app/app/outbox/page");
    const list = renderToStaticMarkup(await List({ searchParams: Promise.resolve({}) }));
    has(list, EMAIL_HELP.sent);
    has(list, EMAIL_HELP.client);
    expect(list).not.toMatch(/>Delivered\b/);
    const em = db.one<{ id: string }>("SELECT id FROM emails WHERE file_id = ? AND kind = 'invite'", fileId)!;
    const { default: Detail } = await import("../app/app/outbox/[id]/page");
    const d = renderToStaticMarkup(await Detail({ params: Promise.resolve({ id: em.id }) }));
    has(d, EMAIL_HELP.sent);
    has(d, EMAIL_HELP.sentExplain);
    has(d, EMAIL_HELP.client);
    expect(d).not.toMatch(/>Delivered\b/);
  });

  it("the next step after sending says the mail server accepted it, and the client may need to check Spam", async () => {
    const { nextStep } = await import("../lib/filepage");
    const f = files.getFile("ws_g", fileId);
    const step = nextStep(f, { admin: true, inviteFailed: false, ready: false, copyEmailed: false, copyFailed: false, outbox: false, autoCountersign: true });
    expect(step.body).toContain(EMAIL_HELP.client);
    expect(step.body).not.toMatch(/was delivered/);
  });

  it("the signer's email-code step says the code can take a minute and to check Spam or Junk", async () => {
    const { VerifyThenDownload } = await import("@/components/SigningRoom");
    const h = renderToStaticMarkup(createElement(VerifyThenDownload, { token: "tok", email: "jordan@example.com" }));
    has(h, EMAIL_HELP.otp);
  });
});
