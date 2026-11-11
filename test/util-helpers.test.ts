import { describe, it, expect } from "vitest";
import { id, token, sha256, now, addDays, safeEqual, escapeHtml, slugKey } from "../lib/util";

describe("util", () => {
  it("id applies the prefix and is url-safe and unique", () => {
    const a = id("f_");
    expect(a.startsWith("f_")).toBe(true);
    expect(a.slice(2)).toMatch(/^[A-Za-z0-9_-]{14}$/);
    expect(id()).not.toBe(id());
  });
  it("token length follows the byte count", () => {
    expect(token()).toHaveLength(32);
    expect(token(8)).toHaveLength(11);
    expect(token(8)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("sha256 matches known vectors for strings and bytes", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(sha256("")).toBe(empty);
    expect(sha256(new Uint8Array())).toBe(empty);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(Buffer.from("abc"))).toBe(sha256("abc"));
  });
  it("now returns a current ISO timestamp", () => {
    const t = Date.parse(now());
    expect(Math.abs(Date.now() - t)).toBeLessThan(5000);
    expect(now()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
  it("addDays handles positive, negative, zero and month rollover", () => {
    expect(addDays("2026-01-30T10:00:00.000Z", 3)).toBe("2026-02-02T10:00:00.000Z");
    expect(addDays("2026-03-01T00:00:00.000Z", -1)).toBe("2026-02-28T00:00:00.000Z");
    expect(addDays("2026-03-01T00:00:00.000Z", 0)).toBe("2026-03-01T00:00:00.000Z");
    expect(addDays("2026-01-01T00:00:00.000Z", 0.5)).toBe("2026-01-01T12:00:00.000Z");
  });
  it("safeEqual compares content and length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    // compares bytes, not characters: same char count, different byte length
    expect(safeEqual("é", "e")).toBe(false);
  });
  it("escapeHtml escapes all five characters, ampersand first", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jo'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jo&#39;&lt;/a&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("plain")).toBe("plain");
  });
  it("slugKey normalises labels", () => {
    expect(slugKey("Client Name")).toBe("client_name");
    expect(slugKey("  --Fee ($)--  ")).toBe("fee");
    expect(slugKey("A  B__C")).toBe("a_b_c");
  });
  it("slugKey falls back to 'field' and truncates to 40", () => {
    expect(slugKey("")).toBe("field");
    expect(slugKey("!!!")).toBe("field");
    expect(slugKey("日本語")).toBe("field");
    expect(slugKey("a".repeat(100))).toHaveLength(40);
  });
  it("slugKey may leave a trailing underscore after truncation", () => {
    // truncation happens after trimming, so a separator at position 40 survives
    expect(slugKey("a".repeat(39) + " b")).toBe("a".repeat(39) + "_");
  });
});
