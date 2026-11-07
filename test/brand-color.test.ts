// Q8-13: a light brand colour made white button text unreadable (#f5c400 on white text: 1.64:1).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contrastWithWhite, readableBrand } from "../lib/brand-color";
import { BRAND } from "../lib/brand";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-brand-"));

describe("readable brand colour", () => {
  it("measures contrast against white as WCAG does", () => {
    expect(contrastWithWhite("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastWithWhite("#000000")).toBeCloseTo(21, 5);
    expect(contrastWithWhite("#f5c400")).toBeCloseTo(1.64, 2); // the colour from the audit
  });
  it("keeps a colour that is already readable, exactly as chosen", () => {
    for (const c of ["#1f4fd1", "#5b6474", "#0d1f59", "#b42318"]) {
      expect(contrastWithWhite(c)).toBeGreaterThanOrEqual(4.5);
      expect(readableBrand(c)).toBe(c);
    }
  });
  it("darkens a light colour, keeping its hue, just enough to reach 4.5:1", () => {
    for (const c of ["#f5c400", "#ffff00", "#7fd3ff", "#ffffff", "#ff8800", "#22c55e"]) {
      const out = readableBrand(c);
      expect(contrastWithWhite(out), `${c} -> ${out}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastWithWhite(out), `${c} -> ${out} isn't darkened more than needed`).toBeLessThan(5.2);
    }
    // same hue: the channels keep their order
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(readableBrand("#f5c400").slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
  it("falls back to the product colour for anything that isn't a #rrggbb colour", () => {
    for (const c of [null, undefined, "", "red", "#fff", "#12345g", "javascript:alert(1)"]) expect(readableBrand(c)).toBe(BRAND.color);
  });
});

describe("the email's button uses the readable colour", () => {
  const button = (html: string) => html.match(/<a href="[^"]*" style="display:inline-block;background:(#[0-9a-f]{6});color:#fff/i)?.[1];
  it("darkens a light brand colour in the call-to-action, and keeps a readable one", async () => {
    const { layout } = await import("../lib/email");
    const light = layout({ brand: "#f5c400", firm: "Northwind", heading: "h", body: "b", cta: { href: "https://app.example.com/s/x", label: "Review and sign" } });
    const bg = button(light);
    expect(bg, "the CTA button is found").toBeTruthy();
    expect(bg!.toLowerCase()).not.toBe("#f5c400");
    expect(contrastWithWhite(bg!)).toBeGreaterThanOrEqual(4.5);
    expect(light).not.toMatch(/#f5c400/i); // nowhere in the email
    const ok = layout({ brand: "#1f4fd1", firm: "Northwind", heading: "h", body: "b", cta: { href: "https://app.example.com/s/x", label: "Open" } });
    expect(button(ok)).toBe("#1f4fd1");
  });
});
