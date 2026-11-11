import { describe, it, expect, afterEach, vi } from "vitest";
import { AppError } from "../lib/errors";
import { CONSENT_SUMMARY, CONSENT_FULL, SIGN_INTENT } from "../lib/consent";
import { dataDir, appUrl } from "../lib/paths";
import { fmtDateTime, fmtDay, APP_TZ } from "../lib/time";
import path from "node:path";

describe("AppError", () => {
  it("defaults to status 400 and keeps the message", () => {
    const e = new AppError("bad");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("bad");
    expect(e.status).toBe(400);
  });
  it("accepts a custom status", () => {
    expect(new AppError("nope", 403).status).toBe(403);
  });
});

describe("consent text", () => {
  it("is non-empty and mentions the key legal points", () => {
    expect(CONSENT_SUMMARY).toMatch(/electronic signature/);
    expect(CONSENT_FULL.length).toBeGreaterThan(3);
    for (const p of CONSENT_FULL) expect(p.trim().length).toBeGreaterThan(0);
    const all = CONSENT_FULL.join("\n");
    expect(all).toMatch(/Withdrawing consent/);
    expect(all).toMatch(/Paper copies/);
    expect(all).toMatch(/ESIGN/);
    expect(SIGN_INTENT).toContain("Sign and finish");
  });
});

describe("paths", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });
  it("dataDir uses DATA_DIR or ./data", () => {
    process.env.DATA_DIR = "/somewhere/else";
    expect(dataDir()).toBe("/somewhere/else");
    delete process.env.DATA_DIR;
    expect(dataDir()).toBe(path.join(process.cwd(), "data"));
    process.env.DATA_DIR = "";
    expect(dataDir()).toBe(path.join(process.cwd(), "data"));
  });
  it("appUrl strips one trailing slash and defaults to localhost", () => {
    process.env.APP_URL = "https://app.example.com/";
    expect(appUrl()).toBe("https://app.example.com");
    process.env.APP_URL = "https://app.example.com//";
    expect(appUrl()).toBe("https://app.example.com/");
    delete process.env.APP_URL;
    expect(appUrl()).toBe("http://localhost:3000");
  });
  it("appUrl warns once in production when APP_URL is unset", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.APP_URL;
    (process.env as Record<string, string>).NODE_ENV = "production";
    appUrl();
    appUrl();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toMatch(/APP_URL is not set/);
  });
});

describe("time", () => {
  it("formats in the configured zone with a zone label", () => {
    expect(typeof APP_TZ).toBe("string");
    const s = fmtDateTime("2026-01-15T17:30:00.000Z");
    expect(s).toMatch(/Jan 15/);
    expect(s).toMatch(/[A-Z]{2,5}|GMT[+-]\d+$/);
  });
  it("fmtDay includes month, day and year", () => {
    expect(fmtDay("2026-07-04T16:00:00.000Z")).toBe(
      new Date("2026-07-04T16:00:00.000Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: APP_TZ }),
    );
    expect(fmtDay("2026-07-04T16:00:00.000Z")).toMatch(/^Jul 4, 2026$/);
  });
  it("fmtDay uses the zone, not UTC, near midnight (default zone only)", () => {
    if (APP_TZ !== "America/New_York") return;
    expect(fmtDay("2026-01-01T02:00:00.000Z")).toBe("Dec 31, 2025");
  });
  it("invalid input yields Invalid Date rather than throwing", () => {
    expect(() => fmtDay("not a date")).not.toThrow();
    expect(fmtDay("not a date")).toBe("Invalid Date");
  });
});
