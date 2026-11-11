// Every email goes out with a plain-text alternative (HTML-only mail is a spam signal). The signing link stays
// usable in it, it has no HTML, and the stored log copy keeps withholding the link.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { htmlToText } from "../lib/email-text";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-email-text-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:3000";
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = ["pw", process.pid, Date.now()].join("-");
type Mail = { to: string; html: string; text: string };
const smtpSent: Mail[] = [];
(globalThis as unknown as { __csmailer: unknown }).__csmailer = { sendMail: async (m: Mail) => (smtpSent.push(m), { messageId: "<m@test>" }) };

const TAG = /<[a-z/!][^>]*>/i;

describe("htmlToText", () => {
  it("links become 'label: URL', block tags become line breaks, styles and scripts go, entities are decoded once", () => {
    const t = htmlToText(
      `<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><h1>Hello &amp; welcome</h1><p>Line one<br>Line   two</p>` +
        `<ul><li>First</li><li>Second</li></ul><a href="https://example.com/s/abc?x=1&amp;y=2">Review and sign</a> <a href="https://example.com/x">https://example.com/x</a>` +
        `<p>Tom&#39;s &quot;quote&quot; &lt;not a tag&gt; &amp;lt;</p><!-- hidden --></body></html>`,
    );
    expect(t).toBe(
      'Hello & welcome\n\nLine one\nLine two\n\n- First\n- Second\n\nReview and sign: https://example.com/s/abc?x=1&y=2 https://example.com/x\n\nTom\'s "quote" <not a tag> &lt;',
    );
    expect(htmlToText('<a href="javascript:alert(1)">Click</a>')).toBe("Click");
  });

  it("the app's email layout: heading, body, the CTA with its link, and no tags", async () => {
    const { layout } = await import("../lib/email");
    const t = htmlToText(layout({ brand: "#1d4ed8", firm: "Northwind & Co", heading: "Please review", body: "Hi Jordan,<br><br>Your agreement is ready.", cta: { href: "http://localhost:3000/s/tok_1", label: "Review and sign" } }));
    expect(t).toContain("Northwind & Co");
    expect(t).toContain("Please review");
    expect(t).toContain("Hi Jordan,\n\nYour agreement is ready.");
    expect(t).toContain("Review and sign: http://localhost:3000/s/tok_1");
    expect(t).not.toMatch(TAG);
  });
});

describe("sendEmail sends the text part", () => {
  let files: typeof import("../lib/files");
  let db: typeof import("../lib/db");
  let email: typeof import("../lib/email");
  beforeAll(async () => {
    db = await import("../lib/db");
    files = await import("../lib/files");
    email = await import("../lib/email");
    const t = new Date().toISOString();
    db.run("INSERT INTO users (id, email, name, password_hash, created_at, email_verified_at) VALUES ('usr_t','avery@example.com','Avery Tester','x',?,?)", t, t);
    db.run("INSERT INTO workspaces (id, name, legal_name, sender_name, countersigner_name, countersigner_email, inbound_token, created_at) VALUES ('ws_t','Northwind','Northwind Advisory, LLC','Northwind','Avery Tester','avery@example.com','inb_t',?)", t);
    db.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES ('ws_t','usr_t','owner',?)", t);
    const ws = files.getWorkspace("ws_t");
    const tpl = await import("../lib/templates");
    const r = await tpl.ingestAgreement(ws, { data: fs.readFileSync("fixtures/agreements/02-msa-two-column.pdf"), filename: "msa.pdf" }, { actor: "test" });
    tpl.publishVersion(ws.id, r.version.id, "test");
  });

  it("SMTP: the signing invitation's text part has the usable signing link and no HTML; the log copy still withholds it", async () => {
    const f = await files.createFile(files.getWorkspace("ws_t"), { clientName: "Jordan Sample", clientEmail: "jordan@example.com" }, { kind: "system", label: "test" }, {});
    const link = files.signingLink(f)!;
    const m = smtpSent.find((x) => x.to === "jordan@example.com")!;
    expect(m.text).toContain(link);
    expect(m.text).not.toMatch(TAG);
    const logged = db.all<{ html: string; status: string }>("SELECT html, status FROM emails WHERE file_id = ?", f.id);
    expect(logged.map((l) => l.status)).toEqual(["sent"]);
    expect(logged[0].html).not.toContain(new URL(link).pathname);
    expect(Object.keys(db.one<Record<string, unknown>>("SELECT * FROM emails WHERE file_id = ?", f.id)!)).not.toContain("text");
  });

  it("Resend: the JSON body carries the same text part", async () => {
    const bodies: { text?: string; html?: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    });
    process.env.RESEND_API_KEY = ["re", "dummy", Date.now()].join("_");
    try {
      const href = "http://localhost:3000/s/link_for_test";
      const r = await email.sendEmail({ workspaceId: "ws_t", kind: "invite", to: "jordan@example.com", subject: "Please sign", html: email.layout({ brand: "#000", firm: "Northwind", heading: "Sign", body: "Ready.", cta: { href, label: "Review and sign" } }), redact: [href] });
      expect(r.delivered).toBe(true);
      expect(bodies[0].text).toContain(`Review and sign: ${href}`);
      expect(bodies[0].text).not.toMatch(TAG);
      expect(db.one<{ html: string }>("SELECT html FROM emails WHERE id = ?", r.id)!.html).not.toContain(href);
    } finally {
      delete process.env.RESEND_API_KEY;
      vi.unstubAllGlobals();
    }
  });
});
