// A first-time reviewer's path: the confirm-your-email screen right after sign-up (inbox, Spam/Junk, Resend, and
// what works before confirming), the Overview's "Start here" links (real routes only), empty states with one clear
// action, and the sign-in page's forgot-password and sign-up links.
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-reviewer-"));
process.env.APP_URL = "http://localhost:3000";

let pathname: string | null = "/app";
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), usePathname: () => pathname }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

const { UnverifiedBanner, VERIFY_COPY } = await import("@/components/VerifyEmailForms");
const { StartHere, START_HERE, KNOWLEDGE_EXAMPLE } = await import("@/components/StartHere");
const { FilesEmpty } = await import("@/components/files/FilesEmpty");
const { LoginForm, SignupForm, AUTH_COPY } = await import("@/components/AuthForms");
const { EMAIL_HELP } = await import("@/lib/email-guidance");
const { AI_COPY } = await import("@/components/studio/ai-state");
const { DOC_AI_COPY } = await import("@/components/intake/ai-copy");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const links = (h: string) => [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), label: text(m[2]).trim() }));
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const ON = { available: true } as const;

describe("right after sign-up: confirm your email", () => {
  it("on Overview, a full card: the address, inbox then Spam/Junk and Not spam, Resend, and what works before and after", () => {
    pathname = "/app";
    const t = text(html(createElement(UnverifiedBanner, { email: "avery@example.com" })));
    expect(t).toContain(VERIFY_COPY.title);
    expect(t).toContain("We sent a confirmation link to avery@example.com");
    expect(t).toContain("Confirm your email to send agreements to clients.");
    expect(t).toMatch(/Check your Spam or Junk folder and mark the email as Not spam/);
    expect(t).toContain(EMAIL_HELP.resend);
    expect(t).toContain(VERIFY_COPY.nowTitle);
    expect(t).toContain(VERIFY_COPY.laterTitle);
    expect(VERIFY_COPY.later.join(" ")).toMatch(/AI features/);
    expect(VERIFY_COPY.later.join(" ")).toMatch(/Sending agreements to clients/);
    expect(VERIFY_COPY.now.join(" ")).toMatch(/Upload a PDF or Word agreement/);
    expect(html(createElement(UnverifiedBanner, { email: "a@example.com" }))).toMatch(/<button type="submit"[^>]*>[\s\S]*Resend link<\/button>/);
  });

  it("on every other page, the compact banner (still with Resend)", () => {
    pathname = "/app/files";
    const t = text(html(createElement(UnverifiedBanner, { email: "avery@example.com" })));
    expect(t).not.toContain(VERIFY_COPY.title);
    expect(t).toContain("Confirm your email to send agreements to clients.");
    expect(t).toContain(EMAIL_HELP.verify);
    expect(t).toContain(EMAIL_HELP.resend);
    pathname = "/app";
  });

  it("the sign-up form says what happens next when confirmation emails are sent", () => {
    expect(text(html(createElement(SignupForm, { confirmNote: true })))).toContain(AUTH_COPY.signupConfirm);
    expect(AUTH_COPY.signupConfirm).toMatch(/Spam or Junk/);
    expect(text(html(createElement(SignupForm)))).not.toContain(AUTH_COPY.signupConfirm);
    expect(src("app/signup/page.tsx")).toContain("confirmNote={verificationRequired()}");
  });
});

describe("Overview: Start here", () => {
  it("links only to real routes, and names the real buttons on them", () => {
    const h = html(createElement(StartHere, { ai: ON, admin: true }));
    const l = links(h);
    expect(l.map((x) => x.label)).toEqual(START_HERE.items.map((i) => i.title));
    expect(l.map((x) => x.href)).toEqual(["/app/documents", "/app/studio#ai-create", "/app/agreements", `/app/knowledge?q=${encodeURIComponent(KNOWLEDGE_EXAMPLE)}`]);
    for (const r of ["documents", "studio", "agreements", "knowledge"]) expect(fs.existsSync(path.join(process.cwd(), `app/app/${r}/page.tsx`)), r).toBe(true);
    expect(src("components/studio/NewAgreement.tsx")).toContain('id="ai-create"');
    expect(src("app/app/knowledge/page.tsx")).toContain("defaultValue={q.q");
    const t = text(h);
    expect(t).toContain(`“${DOC_AI_COPY.sample}”`);
    expect(t).toContain(`“${AI_COPY.exampleButton}”`);
    expect(t).toContain(`“${AI_COPY.button}”`);
    expect(t).not.toMatch(/scan/i);
  });

  it("staff don't get the admin-only upload step; AI steps say when AI isn't available", () => {
    const staff = html(createElement(StartHere, { ai: { available: false, reason: "unverified" }, admin: false }));
    expect(links(staff).map((x) => x.href)).not.toContain("/app/agreements");
    expect(text(staff).split(START_HERE.ai.unverified)).toHaveLength(3); // the two AI steps
    expect(text(html(createElement(StartHere, { ai: ON, admin: true })))).toContain("AI on");
  });

  it("shows only for a brand-new workspace, above the next step", () => {
    const page = src("app/app/page.tsx");
    expect(page).toContain("{ags.length === 0 && m.total === 0 && <StartHere ai={ai} admin={admin} />}");
    expect(page.indexOf("<StartHere")).toBeLessThan(page.indexOf("<NextStep next"));
  });
});

describe("empty states: one clear action", () => {
  it("Files with no published agreement: publish one first (admins get the upload link)", () => {
    const admin = html(createElement(FilesEmpty, { q: "", tabLabel: "All", hasAny: false, canOpen: false, admin: true }));
    expect(links(admin)).toEqual([{ href: "/app/agreements", label: "Upload agreement" }]);
    expect(text(admin)).toMatch(/publish it first/);
    const staff = html(createElement(FilesEmpty, { q: "", tabLabel: "All", hasAny: false, canOpen: false, admin: false }));
    expect(links(staff)).toEqual([]);
    expect(text(staff)).toMatch(/An admin publishes it first/);
  });

  it("Files with a published agreement: open the first file", () => {
    const h = html(createElement(FilesEmpty, { q: "", tabLabel: "All", hasAny: false, canOpen: true }));
    expect(links(h)).toEqual([{ href: "/app/files/new", label: "New file" }]);
    expect(text(h)).toContain("No files yet");
  });
});

describe("sign in", () => {
  it("always shows Forgot your password? and the link to sign up", () => {
    const h = html(createElement(LoginForm, {}));
    expect(links(h)).toEqual([
      { href: "/forgot", label: AUTH_COPY.forgot },
      { href: "/signup", label: AUTH_COPY.create },
    ]);
    expect(h).toMatch(/<label for="login-password"[^>]*>Password<\/label>/);
    expect(src("app/login/page.tsx")).not.toContain("canReset");
    // the reset page itself explains when email isn't configured
    expect(src("app/forgot/page.tsx")).toContain("reset links can&apos;t be sent");
  });
});
