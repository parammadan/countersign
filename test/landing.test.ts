// Public landing page: hero and calls to action for signed-out and signed-in visitors, the four feature sections,
// the workflow steps, labelled illustrative previews, one h1, and no compliance claims, testimonials or metrics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: () => getSession() }));

const { default: Home } = await import("@/app/page");
const { FEATURES, HERO, STEPS, PREVIEW_LABEL, EXPLORE, FOOTER_NOTE } = await import("@/components/landing/copy");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const render = async () => renderToStaticMarkup(await Home());
/** The text a visitor reads, tags stripped. */
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const links = (h: string, label: string) => [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter((m) => text(m[2]).trim() === label).map((m) => m[1]);

const FORBIDDEN = /ESIGN|UETA|eIDAS|compliant|legally binding|testimonial|trusted by|\d+\+ (firms|users|customers)/i;

describe("landing page", () => {
  beforeEach(() => getSession.mockReset());

  describe("signed out", () => {
    beforeEach(() => getSession.mockResolvedValue(null));

    it("shows the hero: eyebrow, one h1 with the headline, the subtitle", async () => {
      const h = await render();
      expect(h.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(h).toMatch(new RegExp(`<h1[^>]*>${HERO.title.replace(/\./g, "\\.")}</h1>`));
      expect(h).toContain(HERO.eyebrow);
      expect(h).toContain(esc(HERO.subtitle));
      for (const w of ["plain English", "citations", "electronic signatures"]) expect(HERO.subtitle).toContain(w);
    });

    it("Get started goes to /signup and Sign in to /login; no Open app", async () => {
      const h = await render();
      expect(links(h, "Get started").length).toBeGreaterThanOrEqual(2);
      expect(new Set(links(h, "Get started"))).toEqual(new Set(["/signup"]));
      expect(links(h, "Sign in").length).toBeGreaterThanOrEqual(2);
      expect(new Set(links(h, "Sign in"))).toEqual(new Set(["/login"]));
      expect(links(h, EXPLORE.cta)).toEqual(["/signup"]);
      expect(links(h, "Open app")).toEqual([]);
    });

    it("header nav: Features and How it works anchors, Verify a document, Sign in", async () => {
      const h = await render();
      const nav = h.match(/<nav aria-label="Main"[\s\S]*?<\/nav>/)![0];
      expect(links(nav, "Features")).toEqual(["#features"]);
      expect(links(nav, "How it works")).toEqual(["#how-it-works"]);
      expect(links(nav, "Verify a document")).toEqual(["/verify"]);
      expect(links(nav, "Sign in")).toEqual(["/login"]);
      expect(h).toContain('id="features"');
      expect(h).toContain('id="how-it-works"');
    });

    it("has the four feature sections and the Create, Review, Sign, Manage steps", async () => {
      const h = await render();
      expect(FEATURES.map((f) => f.title)).toEqual(["Create with AI", "Understand documents", "E-signatures", "Agreement management"]);
      for (const f of FEATURES) {
        expect(h).toMatch(new RegExp(`<h2 id="${f.id}-heading"[^>]*>${f.title}</h2>`));
        expect(h).toContain(esc(f.text));
      }
      expect(STEPS.map((s) => s.title)).toEqual(["Create", "Review", "Sign", "Manage"]);
      for (const s of STEPS) expect(h).toMatch(new RegExp(`<h3[^>]*>${s.title}</h3>`));
    });

    it("labels every preview as illustrative and hides the mock-ups from assistive tech", async () => {
      const h = await render();
      const figures = h.match(/<figure[\s\S]*?<\/figure>/g) ?? [];
      expect(figures).toHaveLength(5);
      for (const f of figures) {
        expect(f).toContain(`<figcaption class="mt-2 text-center text-xs text-muted">${PREVIEW_LABEL}`);
        expect(f).toMatch(/<div aria-hidden="true" class="overflow-hidden/);
        expect(f).not.toMatch(/<(a|button|input|textarea|select)[\s>]/);
      }
      expect(h).toContain("Create an agreement with AI");
      expect(h).toContain("Suggested by Claude");
      expect(h).toContain("Relevant passages");
      expect(h).toContain("Northwind Advisory LLC");
      expect(h).toContain("Acme Widgets Inc");
    });

    it("describes AI accurately: reviewed templates, checked and cited answers, confirmed email for AI", async () => {
      const h = text(await render());
      expect(h).toMatch(/reviewed template/);
      expect(h).toMatch(/doesn't write a custom agreement/);
      expect(h).toMatch(/second admin/);
      expect(h).toMatch(/PDF or DOCX/);
      expect(h).toMatch(/withheld/);
      expect(h).toMatch(/Knowledge Hub/);
      expect(h).toMatch(/AI features need a confirmed email/);
      expect(h).toMatch(/records each signer's consent and an audit trail/i);
      expect(h).not.toMatch(/writes? (your|a|any) (custom )?(contract|legal agreement)|drafts? any agreement/i);
    });

    it("makes no compliance claims, testimonials or usage metrics", async () => {
      const h = await render();
      expect(text(h)).not.toMatch(FORBIDDEN);
      expect(h).not.toMatch(FORBIDDEN);
    });

    it("footer: product name, Sign in, Get started, Verify a document, not-legal-advice note", async () => {
      const h = await render();
      const footer = h.match(/<footer[\s\S]*<\/footer>/)![0];
      expect(footer).toContain("Agreement");
      expect(links(footer, "Sign in")).toEqual(["/login"]);
      expect(links(footer, "Get started")).toEqual(["/signup"]);
      expect(links(footer, "Verify a document")).toEqual(["/verify"]);
      expect(footer).toContain(esc(FOOTER_NOTE));
      expect(FOOTER_NOTE).toMatch(/^Not legal advice/);
    });

    it("has header, main and footer landmarks", async () => {
      const h = await render();
      for (const t of ["header", "main", "footer"]) expect(h).toContain(`<${t}`);
      expect(h).toContain("overflow-x-clip");
    });
  });

  describe("signed in", () => {
    beforeEach(() => getSession.mockResolvedValue({ userId: "u_1", workspaceId: "w_1", role: "owner" }));

    it("shows Open app to /app instead of Get started and the header Sign in", async () => {
      const h = await render();
      expect(links(h, "Open app").length).toBeGreaterThanOrEqual(2);
      expect(new Set(links(h, "Open app"))).toEqual(new Set(["/app"]));
      const nav = h.match(/<nav aria-label="Main"[\s\S]*?<\/nav>/)![0];
      expect(links(nav, "Open app")).toEqual(["/app"]);
      expect(links(nav, "Sign in")).toEqual([]);
      expect(links(nav, "Get started")).toEqual([]);
      expect(links(h, EXPLORE.cta)).toEqual([]);
      expect(h).toContain(HERO.title);
      expect(text(h)).not.toMatch(FORBIDDEN);
    });
  });
});
