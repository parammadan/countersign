// Resend link (confirm your email): at most one a minute and five an hour per user, enforced on the server from
// the links already issued; a no-op once confirmed; and it only ever emails the signed-in user's own address.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-verify-resend-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_RATE_LIMIT_X = "50"; // the per-IP limit is tested elsewhere; here every call shares one address
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = ["pw", process.pid, Date.now()].join("-");
type Mail = { to: string; subject: string; html: string; text: string };
const outbox: Mail[] = [];
(globalThis as unknown as { __csmailer: unknown }).__csmailer = { sendMail: async (m: Mail) => (outbox.push(m), { messageId: `<m${outbox.length}@test>` }) };

const sess = { userId: "usr_a", userName: "Avery Tester", userEmail: "avery@example.com", workspaceId: "ws_a", role: "owner" as const };
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("../lib/auth")>()), getSession: async () => sess, requireSession: async () => sess }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

import { EMAIL_HELP } from "@/lib/email-guidance";

describe("Resend link", () => {
  let db: typeof import("../lib/db");
  let resend: (fd?: FormData) => Promise<import("../app/actions").FormState>;
  const links = (uid: string) => db.one<{ n: number }>("SELECT COUNT(*) n FROM email_verifications WHERE user_id = ?", uid)!.n;
  /** move every issued link back in time, as if the user waited */
  const age = (ms: number) => db.run("UPDATE email_verifications SET created_at = ?", new Date(Date.now() - ms).toISOString());

  beforeAll(async () => {
    db = await import("../lib/db");
    const actions = await import("../app/actions");
    resend = (fd?: FormData) => (actions.resendVerificationAction as unknown as (s: undefined, f?: FormData) => ReturnType<typeof actions.resendVerificationAction>)(undefined, fd);
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_a','avery@example.com','Avery Tester','x',?)", t);
    db.run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_b','blake@example.com','Blake Other','x',?)", t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_a','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_a',?)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_a','usr_a','owner',?)", t);
  });
  beforeEach(() => {
    outbox.length = 0;
    db.run("DELETE FROM email_verifications");
    db.run("UPDATE users SET email_verified_at = NULL");
  });

  it("sends a new link with the guidance, then refuses a second one within 60 s with a friendly message", async () => {
    expect(await resend()).toEqual({ ok: EMAIL_HELP.resent("avery@example.com") });
    expect(EMAIL_HELP.resent("x")).toMatch(/check Spam or Junk/);
    expect(outbox).toHaveLength(1);
    expect(await resend()).toEqual({ error: EMAIL_HELP.tooSoon });
    expect(outbox).toHaveLength(1);
    expect(links("usr_a")).toBe(1);
    age(61_000);
    expect((await resend())?.ok).toBeTruthy();
    expect(outbox).toHaveLength(2);
  });

  it("the sign-up email counts: Resend right after signing up is refused", async () => {
    const { sendVerification } = await import("../lib/emailverify");
    await sendVerification({ id: "usr_a", email: "avery@example.com", name: "Avery Tester" }, "ws_a");
    expect(await resend()).toEqual({ error: EMAIL_HELP.tooSoon });
    expect(outbox).toHaveLength(1);
  });

  it("at most 5 links an hour", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await resend())?.ok, `link ${i + 1}`).toBeTruthy();
      age(61_000 + i); // over a minute ago, still within the hour
    }
    expect(await resend()).toEqual({ error: EMAIL_HELP.tooMany });
    expect(outbox).toHaveLength(5);
    age(3601_000);
    expect((await resend())?.ok).toBeTruthy();
  });

  it("is a no-op once the email is confirmed", async () => {
    db.run("UPDATE users SET email_verified_at = ? WHERE id = 'usr_a'", new Date().toISOString());
    expect(await resend()).toEqual({ ok: EMAIL_HELP.alreadyVerified });
    expect(await resend()).toEqual({ ok: EMAIL_HELP.alreadyVerified });
    expect(outbox).toHaveLength(0);
    expect(links("usr_a")).toBe(0);
  });

  it("ignores any address in the request: the same response for an existing and an unknown address, and only the user's own inbox gets mail", async () => {
    const withEmail = (email: string) => {
      const fd = new FormData();
      fd.set("email", email);
      return fd;
    };
    const known = await resend(withEmail("blake@example.com"));
    age(61_000);
    const unknown = await resend(withEmail("nobody@example.com"));
    expect(known).toEqual(unknown);
    expect(known).toEqual({ ok: EMAIL_HELP.resent("avery@example.com") });
    expect(outbox.map((m) => m.to)).toEqual(["avery@example.com", "avery@example.com"]);
    expect(links("usr_b")).toBe(0);
    // refused the same way too
    expect(await resend(withEmail("blake@example.com"))).toEqual(await resend(withEmail("nobody@example.com")));
  });

  it("the link email carries a plain-text part with the usable confirmation link, and the log keeps it withheld", async () => {
    await resend();
    const m = outbox[0];
    expect(m.text).toMatch(/Confirm my email: http:\/\/localhost:3000\/confirm-email\/\S+/);
    expect(m.text).not.toMatch(/<[a-z/!][^>]*>/i);
    const logged = db.one<{ html: string }>("SELECT html FROM emails WHERE kind = 'verify_email' ORDER BY rowid DESC LIMIT 1")!;
    expect(logged.html).not.toContain("/confirm-email/");
  });
});
