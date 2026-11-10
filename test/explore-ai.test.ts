// Overview "Explore AI features": the three AI features are linked with an example to try, the card says when AI
// is off or paused and why, and its wording describes what the AI actually does (no unrestricted drafting).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExploreAi, EXPLORE_AI } from "@/components/ExploreAi";

const html = (ai: Parameters<typeof ExploreAi>[0]["ai"], askHref: string | null = "/app/agreements/tv_1/ask") => renderToStaticMarkup(createElement(ExploreAi, { ai, askHref }));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("Explore AI features", () => {
  it("links Studio, Ask and the Knowledge Hub, each with an example, and shows AI on", () => {
    const h = html({ available: true });
    expect(h).toContain('href="/app/studio"');
    expect(h).toContain(`href="/app/agreements/tv_1/ask?q=${encodeURIComponent(EXPLORE_AI.ask.example)}"`);
    expect(h).toContain(`href="/app/knowledge?q=${encodeURIComponent(EXPLORE_AI.knowledge.example)}"`);
    for (const t of [EXPLORE_AI.studio.title, EXPLORE_AI.ask.title, EXPLORE_AI.knowledge.title]) expect(h).toContain(t);
    expect(h).toContain("AI on");
  });
  it("without an agreement yet, Ask points to the agreements list and says what to do first", () => {
    const h = html({ available: true }, null);
    expect(h).toContain('href="/app/agreements"');
    expect(h).toContain("Upload an agreement first");
  });
  for (const reason of ["off", "unverified", "spend_cap"] as const)
    it(`${reason}: says why AI isn't running`, () => {
      const h = html({ available: false, reason });
      expect(h).toContain(esc(EXPLORE_AI.state[reason]));
      expect(h).not.toContain(">AI on<");
    });
  it("describes the real capabilities: template details, cited answers, human approval; no custom legal drafting claims", () => {
    const all = JSON.stringify(EXPLORE_AI);
    expect(EXPLORE_AI.studio.text).toMatch(/reviewed template/);
    expect(EXPLORE_AI.knowledge.text).toMatch(/cite/);
    expect(EXPLORE_AI.description).toMatch(/approves/);
    expect(all).not.toMatch(/writes? (your|a) (custom )?(contract|agreement)|legal advice from AI|any agreement you want/i);
  });
});
