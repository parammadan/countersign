// APP_SECRET seals signing links and the signer's verification cookie. In production it must be set: a secret
// generated on the fly would differ on a new volume or machine and silently break every link already sent.
// In development and tests a generated one, kept next to the database, is still fine.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["NODE_ENV", "APP_SECRET", "DATA_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]])) as Record<(typeof KEYS)[number], string | undefined>;
let dir = "";

function restore(k: (typeof KEYS)[number]) {
  if (saved[k] === undefined) delete env[k];
  else env[k] = saved[k];
}

describe("APP_SECRET", () => {
  beforeEach(() => {
    vi.resetModules(); // the key is cached per module instance
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-secret-"));
    env.DATA_DIR = dir;
    delete env.APP_SECRET;
  });
  afterEach(() => {
    restore("NODE_ENV");
    restore("APP_SECRET");
    restore("DATA_DIR");
  });

  it("in production, a missing APP_SECRET fails closed: nothing is sealed or opened, and no secret is generated", async () => {
    env.NODE_ENV = "production";
    const s = await import("../lib/secret");
    expect(() => s.seal("token")).toThrow(/APP_SECRET/);
    const wellFormed = [Buffer.alloc(12), Buffer.alloc(16), Buffer.from("x")].map((b) => b.toString("base64url")).join(".");
    expect(() => s.unseal(wellFormed)).toThrow(/APP_SECRET/);
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(false);
  });

  it("in production with APP_SECRET set, values round-trip", async () => {
    env.NODE_ENV = "production";
    env.APP_SECRET = ["test", "only", "not", "a", "real", "secret"].join("-");
    const s = await import("../lib/secret");
    expect(s.unseal(s.seal("token"))).toBe("token");
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(false);
  });

  it("in development and tests, a secret is still generated and kept next to the database", async () => {
    env.NODE_ENV = "test";
    const s = await import("../lib/secret");
    const sealed = s.seal("token");
    expect(fs.existsSync(path.join(dir, ".secret"))).toBe(true);
    vi.resetModules();
    const again = await import("../lib/secret");
    expect(again.unseal(sealed)).toBe("token");
  });
});
