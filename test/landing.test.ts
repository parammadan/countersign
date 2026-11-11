// Public landing page: hero and calls to action for signed-out and signed-in visitors, the feature sections, the
// workflow steps, labelled illustrative previews, one h1, Document Intelligence wording that follows its flag, and no
// compliance claims, testimonials or metrics.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: () => getSession() }));

const { default: Home } = await import("@/app/page");
const copy = await import("@/components/landing/copy");
const { FEATURES, HERO, STEPS, PREVIEW_LABEL, CTA, FOOTER, HOW, NAV, DOC_INTEL, DOC_INTEL_AI, DOC_INTEL_COPY, PHONE_SIGN, PHONE_SCAN, PHONE_SCAN_COPY, VOICE_INPUT, VOICE_INPUT_COPY } = copy;

const render = async () => renderToStaticMarkup(await Home());
/** The text a visitor reads, tags stripped. */
const text = (h: string) =>
  h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const links = (h: string, label: string) => [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter((m) => text(m[2]).trim() === label).map((m) => m[1]);
const nav = (h: string) => h.match(/<nav aria-label="Main"[\s\S]*?<\/nav>/)![0];
/** The phone menu's panel, and the header bar without it. */
const menu = (h: string) => h.match(/<div id="landing-menu"[\s\S]*?<\/ul>/)![0];
const bar = (h: string) => nav(h).replace(menu(h), "");
const footer = (h: string) => h.match(/<footer[\s\S]*<\/footer>/)![0];

const FORBIDDEN =
  /ESIGN|UETA|eIDAS|\bSOC ?2\b|HIPAA|GDPR|ISO ?27001|compliant|compliance|legally binding|certified|bank-grade|military-grade|testimonial|trusted by|\d+\+ (firms|users|customers|teams)|\d+(\.\d+)?% |\b\d+x faster/i;
/** Claims of unrestricted drafting: Claude only fills in reviewed templates. */
const DRAFTING = /(?<!(n't|not|never) )\bwrites? (your|a|any) (custom )?(contract|legal agreement|agreement)|drafts? any (agreement|contract)|any contract you need/i;

describe("landing page", () => {
  beforeEach(() => getSession.mockReset());

  describe("signed out", () => {
    beforeEach(() => getSession.mockResolvedValue(null));

    it("hero: eyebrow, one h1 with the headline, the subtitle", async () => {
      const h = await render();
      expect(h.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(text(h.match(/<h1[\s\S]*?<\/h1>/)![0]).trim()).toBe("From first draft to final signature. One intelligent workspace.");
      expect(HERO.title).toBe(`${HERO.titleLead} ${HERO.titleAccent}`);
      expect(HERO.eyebrow.toUpperCase()).toBe("AI-POWERED AGREEMENT WORKSPACE");
      expect(h).toContain(HERO.eyebrow);
      expect(text(h)).toContain("Create agreements with AI, understand documents, manage approvals, and send contracts for signature—all in one place.");
    });

    it("hero preview: the real Studio panel copy, sample fields, and the not-a-live-response caption", async () => {
      const h = text(await render());
      for (const t of ["Create an agreement with AI", "Tell AI what you need", "Fill details with AI", "Suggested by Claude: check it", "Consulting", "$12,000", "a one-time fixed fee", "Delaware", "Northwind Advisory LLC", "Acme Widgets Inc"])
        expect(h).toContain(t);
      expect(h).toContain("Illustrative example, not a live AI response.");
      expect(h).toContain("One connected workflow: Create · Understand · Approve · Sign");
    });

    it("hero: Create workspace and Explore features side by side", async () => {
      const h = await render();
      const hero = h.match(/<section aria-labelledby="hero-heading"[\s\S]*?<\/section>/)![0];
      expect(links(hero, NAV.create)).toEqual(["/signup"]);
      expect(links(hero, NAV.explore)).toEqual(["#features"]);
      expect(text(hero)).not.toContain("See how it works");
    });
    it("Create workspace goes to /signup and Sign in to /login; no Open app", async () => {
      const h = await render();
      expect(links(h, "Create workspace").length).toBeGreaterThanOrEqual(4);
      expect(new Set(links(h, "Create workspace"))).toEqual(new Set(["/signup"]));
      expect(links(h, "Sign in").length).toBeGreaterThanOrEqual(2);
      expect(new Set(links(h, "Sign in"))).toEqual(new Set(["/login"]));
      expect(links(h, "Open app")).toEqual([]);
    });

    it("header nav: Features, How it works, Verify document, Sign in, Create workspace", async () => {
      const h = await render();
      const n = bar(h);
      expect(links(n, NAV.features)).toEqual(["#features"]);
      expect(links(n, NAV.how)).toEqual(["#how-it-works"]);
      expect(links(n, "Verify document")).toEqual(["/verify"]);
      expect(links(n, "Sign in")).toEqual(["/login"]);
      expect(links(n, "Create workspace")).toEqual(["/signup"]);
      expect(h).toContain('id="features"');
      expect(h).toContain('id="how-it-works"');
    });

    it("phone menu: a closed disclosure button listing every section, Verify document and Create workspace", async () => {
      const h = await render();
      expect(nav(h)).toMatch(/<button type="button" aria-expanded="false" aria-controls="landing-menu"/);
      expect(text(nav(h).match(/<button[\s\S]*?<\/button>/)![0]).trim()).toBe("Menu");
      const m = menu(h);
      expect(m).toMatch(/<div id="landing-menu" hidden=""/);
      expect(links(m, NAV.features)).toEqual(["#features"]);
      for (const f of FEATURES) {
        expect(links(m, f.eyebrow)).toEqual([`#${f.id}`]);
        expect(h).toContain(`id="${f.id}"`);
      }
      expect(links(m, NAV.how)).toEqual(["#how-it-works"]);
      expect(links(m, "Verify document")).toEqual(["/verify"]);
      expect(links(m, "Create workspace")).toEqual(["/signup"]);
      expect(links(m, "Open app")).toEqual([]);
      // on phones the header keeps Sign in; the header's Create workspace is hidden below sm (it's in the menu)
      expect(bar(h)).toMatch(/<span class="ml-1.5 hidden sm:inline-flex"><a [^>]*href="\/signup"/);
    });

    it("features strip: one link per feature section, under the features heading", async () => {
      const h = await render();
      const strip = h.match(/<nav aria-label="Features"[\s\S]*?<\/nav>/)![0];
      expect(FEATURES.map((f) => links(strip, f.eyebrow)[0])).toEqual(FEATURES.map((f) => `#${f.id}`));
    });

    it("every in-page link points at a section that exists", async () => {
      const h = await render();
      const ids = new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      const anchors = [...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      expect(anchors.length).toBeGreaterThan(10);
      for (const a of anchors) expect(ids, `#${a}`).toContain(a);
      const pages = new Set([...h.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]));
      expect([...pages].sort()).toEqual(["/", "/login", "/signup", "/verify"]);
    });

    it("has no product demo video, nav item or embed", async () => {
      const h = await render();
      expect(h).not.toMatch(/youtube|<iframe|id="demo"|#demo|Watch product demo|Product demo/i);
    });

    it("has the five feature sections, each with its heading and text", async () => {
      const h = await render();
      expect(FEATURES.map((f) => f.eyebrow)).toEqual(["Agreement Studio", "Document Intelligence", "Knowledge Hub", "E-signatures", "Clause Library & approvals"]);
      for (const f of FEATURES) {
        expect(h).toContain(`id="${f.id}"`);
        expect(text(h.match(new RegExp(`<h2 id="${f.id}-heading"[^>]*>[\\s\\S]*?</h2>`))![0]).trim()).toBe(f.title);
        expect(text(h)).toContain(f.text);
        for (const p of f.points) expect(text(h)).toContain(p);
      }
    });

    it("how it works: four steps and the no-AI upload note", async () => {
      const h = await render();
      expect(STEPS.map((s) => s.title)).toEqual(["Create", "Understand & Review", "Approve", "Sign & Manage"]);
      for (const s of STEPS) expect(text(h)).toMatch(new RegExp(`Step \\d ${s.title} `));
      expect(HOW.note).toBe("Already have an agreement? Upload your PDF or Word file and send it for signing — no AI needed.");
      expect(text(h)).toContain(HOW.note);
    });

    it("labels every preview as illustrative and hides the mock-ups from assistive tech", async () => {
      const h = await render();
      const figures = h.match(/<figure[\s\S]*?<\/figure>/g) ?? [];
      expect(figures.length).toBeGreaterThanOrEqual(9);
      for (const f of figures) {
        expect(text(f.match(/<figcaption[\s\S]*?<\/figcaption>/)![0])).toMatch(new RegExp(`^ ?(${PREVIEW_LABEL}|${HERO.caption.replace(/\./g, "\\.")}) ?:`));
        expect(f).toMatch(/<div aria-hidden="true" class="relative">/);
        expect(f).not.toMatch(/<(a|button|input|textarea|select|iframe)[\s>]/);
      }
      expect(figures.filter((f) => f.includes(HERO.caption))).toHaveLength(1);
    });

    it("describes AI accurately: reviewed templates, second admin, checked and cited answers", async () => {
      const h = text(await render());
      expect(h).toMatch(/reviewed templates?/);
      expect(h).toMatch(/doesn't write a custom agreement/);
      expect(h).toMatch(/second admin/);
      expect(h).toMatch(/PDF or DOCX/);
      expect(h).toMatch(/withheld if they can't be verified/);
      expect(h).toMatch(/agreement and page/);
      expect(h).toMatch(/nothing in your agreements supports an answer/i);
      expect(h).toMatch(/Ask about this agreement/);
      expect(h).toMatch(/AI features and sending to clients need a confirmed email/);
      expect(h).toMatch(/records each signer's consent and an audit trail/i);
      expect(h).toMatch(/automatic countersignature|countersignature is applied automatically/i);
      expect(h).toMatch(/sealed PDF with an audit certificate/);
      expect(h).toMatch(/public verify page/);
      expect(h).not.toMatch(DRAFTING);
    });

    it("Document Intelligence follows its one flag: the AI version is live", async () => {
      const h = text(await render());
      expect(DOC_INTEL_AI).toBe(true);
      expect(DOC_INTEL).toBe(DOC_INTEL_COPY.ai);
      expect(h).toContain(DOC_INTEL_COPY.ai.text);
      expect(h).not.toContain("Rules only: no AI");
      expect(h).toMatch(/AI summary/);
      // the AI wording: summary, cited key terms, chat with one document, not legal advice
      const ai = [DOC_INTEL_COPY.ai.text, ...DOC_INTEL_COPY.ai.points].join(" ");
      for (const w of [/AI summary/, /key terms/, /cited/, /chat with (that|this) one document/i, /Informational, not legal advice/]) expect(ai).toMatch(w);
      expect(DOC_INTEL_COPY.ai.id).toBe(DOC_INTEL_COPY.rules.id);
      // the section, chips and preview show the AI analysis: summary, quoted key terms, one-document chat, Studio handoff
      for (const p of DOC_INTEL_COPY.ai.points) expect(h).toContain(p);
      for (const c of DOC_INTEL_COPY.ai.chips) expect(h).toContain(c);
      for (const t of ["In plain English", "Key terms", "Chat with this document", "Start a draft in Agreement Studio", "Informational, not legal advice"]) expect(h).toContain(t);
      expect(h).toMatch(/p\. 3: “either party may terminate/);
      expect(h).not.toContain("Ignore previous instructions");
    });

    it("tells Document Intelligence (one document) apart from Knowledge Hub (all agreements)", async () => {
      const t = text(await render());
      expect(DOC_INTEL.title).toMatch(/^One document/);
      expect(DOC_INTEL.text).toMatch(/single PDF or Word document/);
      expect(t).toContain("All your agreements: ask across them");
      expect(t).toContain("across every agreement indexed in your workspace");
    });
    it("Sign on your phone: the live QR handoff is described, with its preview", async () => {
      const h = await render();
      const t = text(h);
      expect(t).toContain(PHONE_SIGN.title);
      expect(t).toContain(PHONE_SIGN.text);
      for (const p of PHONE_SIGN.points) expect(t).toContain(p);
      expect(PHONE_SIGN.text).toMatch(/QR code/);
      expect(PHONE_SIGN.text).toMatch(/same signing link/);
      expect(PHONE_SIGN.text).toMatch(/updates by itself/);
      const fig = (h.match(/<figure[\s\S]*?<\/figure>/g) ?? []).find((f) => f.includes("Sign on your phone"))!;
      expect(fig).toBeTruthy();
      expect(fig).toContain("<svg");
      expect(text(fig)).toContain("Scan with your phone's camera. You'll sign there; this page updates when you're done.");
    });

    it("voice input is shown once; phone scanning stays off the page until it passes a real-phone test", async () => {
      expect(PHONE_SCAN).toBe(false);
      expect(VOICE_INPUT).toBe(true);
      const t = text(await render());
      expect(t).not.toContain(PHONE_SCAN_COPY.text);
      expect(t).not.toContain(PHONE_SCAN_COPY.label);
      expect(t.split(VOICE_INPUT_COPY.text)).toHaveLength(2);
    });

    it("makes no compliance claims, testimonials, metrics or drafting claims anywhere in the copy", async () => {
      const h = await render();
      expect(text(h)).not.toMatch(FORBIDDEN);
      expect(h).not.toMatch(FORBIDDEN);
      const all = JSON.stringify(copy);
      expect(all).not.toMatch(FORBIDDEN);
      expect(all).not.toMatch(DRAFTING);
    });

    it("final call to action and footer", async () => {
      const h = await render();
      expect(text(h.match(/<h2 id="cta-heading"[\s\S]*?<\/h2>/)![0]).trim()).toBe("Your next agreement starts here.");
      expect(text(h)).toContain(CTA.text);
      const f = footer(h);
      expect(f).toContain("Agreement");
      expect(links(f, "Verify a document")).toEqual(["/verify"]);
      expect(links(f, "Sign in")).toEqual(["/login"]);
      expect(links(f, "Create workspace")).toEqual(["/signup"]);
      expect(text(f)).toContain(FOOTER.about);
      expect(text(f)).toContain(FOOTER.note);
      expect(FOOTER.note).toMatch(/^Informational, not legal advice/);
    });

    it("has header, main and footer landmarks and clips horizontal overflow", async () => {
      const h = await render();
      for (const t of ["header", "main", "footer"]) expect(h).toContain(`<${t}`);
      expect(h).toContain("overflow-x-clip");
    });
  });

  describe("when the phone scanning and voice input flags are flipped", () => {
    afterEach(() => {
      vi.doUnmock("@/components/landing/copy");
      vi.resetModules();
    });

    it("each one's copy appears, once", async () => {
      vi.resetModules();
      vi.doMock("@/components/landing/copy", async (orig) => ({ ...(await orig<typeof copy>()), PHONE_SCAN: true, VOICE_INPUT: true }));
      const { default: Flipped } = await import("@/app/page");
      getSession.mockResolvedValue(null);
      const t = text(renderToStaticMarkup(await Flipped()));
      for (const x of [PHONE_SCAN_COPY.text, VOICE_INPUT_COPY.text]) expect(t.split(x)).toHaveLength(2);
      expect(t).toContain(`${PHONE_SCAN_COPY.label}.`);
      expect(t).toContain(`${VOICE_INPUT_COPY.label}.`);
      expect(t).not.toMatch(FORBIDDEN);
    });
  });

  describe("signed in", () => {
    beforeEach(() => getSession.mockResolvedValue({ userId: "u_1", workspaceId: "w_1", role: "owner" }));

    it("shows Open app to /app instead of the header Sign in and Create workspace", async () => {
      const h = await render();
      expect(links(h, "Open app").length).toBeGreaterThanOrEqual(3);
      expect(new Set(links(h, "Open app"))).toEqual(new Set(["/app"]));
      const n = bar(h);
      expect(links(n, "Open app")).toEqual(["/app"]);
      expect(links(n, "Sign in")).toEqual([]);
      expect(links(n, "Create workspace")).toEqual([]);
      expect(links(menu(h), "Open app")).toEqual(["/app"]);
      expect(links(menu(h), "Create workspace")).toEqual([]);
      const pages = new Set([...h.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]));
      expect([...pages].sort()).toEqual(["/", "/app", "/login", "/signup", "/verify"]);
      expect(links(h.replace(footer(h), ""), "Create workspace")).toEqual([]);
      expect(text(h)).toContain(HERO.title);
      expect(text(h)).not.toMatch(FORBIDDEN);
    });
  });
});
