// Convention guard: there is no middleware, so every route and server action authenticates itself.
// A new route or action that skips the check fails here. Public ones are listed explicitly.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (f: string) => f.split(path.sep).join("/");

// Public by design: authorised by an unguessable link token (and rate limited), or no data at all.
const PUBLIC_ROUTES = new Set(["app/api/health/route.ts", "app/api/verify/route.ts", "app/api/inbound/[token]/route.ts"]);
const AUTH = /sessionOr401\(|apiAuth\(|loadByToken\(|rateLimit\(/;

describe("every route authenticates or rate limits itself", () => {
  const routes = walk("app/api").filter((f) => f.endsWith("route.ts")).map(rel);
  it("finds the routes", () => expect(routes.length).toBeGreaterThan(20));
  for (const r of routes)
    it(r, () => {
      const src = fs.readFileSync(r, "utf8");
      if (r.startsWith("app/api/sign/")) return expect(src).toMatch(/rateLimit\(|limited\(/); // token links: limited per IP
      if (r.startsWith("app/api/scan/phone/")) return expect(src).toMatch(/phoneLimit\(/); // phone scan: token link, limited per IP and token
      if (PUBLIC_ROUTES.has(r)) return expect(src).toMatch(/rateLimit\(|ok: true/);
      expect(src, "needs sessionOr401 or apiAuth").toMatch(/sessionOr401\(|apiAuth\(/);
      expect(src).toMatch(AUTH);
    });
  it("/api/v1 routes use API-key auth only, never a cookie session", () => {
    for (const r of routes.filter((x) => x.startsWith("app/api/v1/"))) expect(fs.readFileSync(r, "utf8"), r).toMatch(/apiAuth\(/);
  });
});

// Public by nature: they take credentials or a token and call throttle().
const PUBLIC_ACTIONS = new Set(["signupAction", "loginAction", "logoutAction", "acceptInviteAction", "resendVerificationAction", "confirmEmailAction", "forgotAction", "resetAction"]);

describe("every server action requires a session (or is throttled and public)", () => {
  const actionFiles = fs.readdirSync("app").filter((f) => /actions\.ts$/.test(f)).map((f) => `app/${f}`);
  for (const file of actionFiles) {
    const src = fs.readFileSync(file, "utf8");
    const parts = src.split(/^export async function /m).slice(1);
    for (const part of parts) {
      const name = /^(\w+)/.exec(part)![1];
      it(`${file} ${name}`, () => {
        const body = part.slice(0, part.search(/\n}\n/) + 3);
        if (PUBLIC_ACTIONS.has(name)) return expect(body).toMatch(/throttle\(|destroySession\(/);
        expect(body, "needs requireSession/requireAdmin").toMatch(/requireSession\(|requireAdmin\(/);
      });
    }
  }
});
