// "Sign on your phone": the QR code the signing room shows is made on the server from the exact signing link, and
// it scans: the served SVG is rasterised here and decoded with jsQR, a QR reader independent of the generator. The
// signing room offers the button (desktop widths only), and its dialog has the QR image, the copy-link fallback and
// a live status line.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import QRCode from "qrcode";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// the signature pad's handwriting fonts are a build-time Next.js feature
vi.mock("next/font/google", () => ({ Dancing_Script: () => ({ style: { fontFamily: "a" } }), Caveat: () => ({ style: { fontFamily: "b" } }) }));

import { qrDataUrl } from "@/lib/qr";
import { SigningRoom } from "@/components/SigningRoom";
import { SignOnPhone, outcomeText } from "@/components/SignOnPhone";

// a synthetic link of the real shape: APP_URL + /s/ + a 43-character base64url token
const URLS = ["http://localhost:3000/s/" + "aZ09_-".repeat(7) + "x", "https://sign.example.test/s/" + "Qw3_rT-y".repeat(5) + "abc"];

function svgOf(dataUrl: string) {
  const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  expect(m, "an SVG data URL").not.toBeNull();
  return Buffer.from(m![1], "base64").toString("utf8");
}

/** The dark modules of qrcode's SVG output: a stroked path of 1-module-high runs ("M x y.5 h len m dx dy h len ..."). */
function modules(svg: string): { size: number; dark: boolean[][] } {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)![1]);
  const d = /<path stroke="#000000" d="([^"]+)"/.exec(svg)![1];
  const dark = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  let x = 0,
    y = 0;
  for (const [, cmd, args] of d.matchAll(/([MmHh])([^MmHh]*)/g)) {
    const n = args.trim().split(/[ ,]+/).filter(Boolean).map(Number);
    if (cmd === "M") [x, y] = [n[0], n[1]];
    else if (cmd === "m") [x, y] = [x + n[0], y + n[1]];
    else if (cmd === "h") {
      for (let i = 0; i < n[0]; i++) dark[Math.floor(y)][x + i] = true;
      x += n[0];
    } else throw new Error(`unexpected path command ${cmd}`);
  }
  return { size, dark };
}

/** Rasterise a module grid to RGBA, `scale` px a module, with a 4-module white quiet zone around it. */
function rgba({ size, dark }: { size: number; dark: boolean[][] }, scale = 6) {
  const q = 4;
  const w = (size + 2 * q) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      if (!dark[r][c]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((r + q) * scale + dy) * w + (c + q) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }
  return { px, w };
}

describe("the QR code", () => {
  for (const url of URLS)
    it(`decodes to exactly the signing link (${new URL(url).host})`, async () => {
      const svg = svgOf(await qrDataUrl(url));
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/<script|on\w+=|href=|<foreignObject/i); // nothing but shapes
      expect(svg).not.toContain(url); // the link is encoded, not embedded as text
      const grid = modules(svg);
      const { px, w } = rgba(grid);
      const read = jsQR(px, w, w);
      expect(read, "jsQR found a code").not.toBeNull();
      expect(read!.data).toBe(url);
      // the served SVG is the library's matrix for this link at level M, one module of margin
      const ref = QRCode.create(url, { errorCorrectionLevel: "M" });
      expect(grid.size).toBe(ref.modules.size + 2);
      for (let r = 0; r < ref.modules.size; r++)
        for (let c = 0; c < ref.modules.size; c++) expect(grid.dark[r + 1][c + 1]).toBe(!!ref.modules.get(r, c));
    });

  it("a different link gives a different code", async () => {
    const [a, b] = await Promise.all([qrDataUrl(URLS[0]), qrDataUrl(URLS[0].replace(/x$/, "y"))]);
    expect(a).not.toBe(b);
  });
});

describe("the signing room offers it", () => {
  const props = {
    token: "aZ09_-".repeat(7) + "x",
    firm: "Northwind",
    agreement: "Engagement letter",
    title: "Synthetic matter",
    clientName: "Jordan Sample",
    clientEmail: "jordan@example.com",
    clientCompany: null,
    pages: [],
    fields: [],
    today: "Nov 10, 2026",
    requireOtp: false,
    otpVerified: true,
    consented: false,
    signUrl: URLS[0],
    qr: "data:image/svg+xml;base64,PHN2Zy8+",
  };

  for (const [stage, extra] of [
    ["intro", {}],
    ["sign", { consented: true }],
    ["otp", { requireOtp: true, otpVerified: false }],
  ] as const)
    it(`in the ${stage} stage, as a button shown only on desktop widths`, () => {
      const h = renderToStaticMarkup(createElement(SigningRoom, { ...props, ...extra }));
      const btn = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Sign on your phone<\/button>/.exec(h)?.[0];
      expect(btn, "the button").toBeTruthy();
      expect(btn).toMatch(/class="[^"]*\bhidden\b[^"]*\blg:inline-flex\b/);
      expect(btn).toContain('aria-haspopup="dialog"');
      expect(btn).toContain("<svg"); // the phone icon
      expect(h).not.toContain('role="dialog"'); // closed until asked
      expect(h).not.toContain(props.signUrl); // the link isn't printed on the page
    });

  it("the dialog: the QR image (a data URL, not inline markup), instructions, copy link, live status", () => {
    const h = renderToStaticMarkup(createElement(SignOnPhone, { token: props.token, firm: "Northwind", signUrl: URLS[0], qr: props.qr, requireOtp: true, defaultOpen: true }));
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-label="Sign on your phone"');
    expect(h).toMatch(/<img[^>]+src="data:image\/svg\+xml;base64,PHN2Zy8\+"[^>]*alt="QR code of this signing link"|<img[^>]+alt="QR code of this signing link"[^>]*src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
    expect(h).toContain("Scan with your phone&#x27;s camera. You&#x27;ll sign there; this page updates when you&#x27;re done.");
    expect(h).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Copy link<\/button>/);
    expect(h).toMatch(/role="status" aria-live="polite"[^>]*>[\s\S]*Waiting for you to sign on your phone…/);
    expect(h).toContain("code we email you"); // the phone goes through the emailed code like any device
    expect(h).not.toContain("<svg/>"); // the QR SVG is never inlined
  });

  it("says what happened, for every way the agreement can stop waiting", () => {
    expect(outcomeText("signed", "Northwind")).toEqual({
      title: "Signed on your phone",
      body: "Thanks — Northwind is countersigning now; you'll get the completed copy by email.",
      good: true,
    });
    expect(outcomeText("completed", "Northwind").title).toBe("Signed on your phone");
    expect(outcomeText("declined", "Northwind").title).toBe("You declined this agreement");
    expect(outcomeText("voided", "Northwind").title).toBe("This agreement was withdrawn");
    expect(outcomeText("expired", "Northwind").title).toBe("This link has expired");
    expect(outcomeText("invalid", "Northwind").title).toBe("This link isn't valid any more");
  });
});
