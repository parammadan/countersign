// The Studio form shows AI controls only when the server says AI would run for this workspace; otherwise a fixed
// notice says why. Server-rendered with the router and the server actions stubbed (nothing is called).
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/app/studio-actions", () => ({ suggestAction: vi.fn(), createDraftAction: vi.fn() }));

import { NewAgreement } from "@/components/studio/NewAgreement";
import { AI_UNAVAILABLE, aiBadge } from "@/components/studio/ai-state";
import type { KindSpec, StudioAi } from "@/lib/drafts/service";

const kinds: KindSpec[] = [{ kind: "nda", title: "Mutual NDA", roles: ["Disclosing Party", "Receiving Party"], terms: [{ key: "startDate", type: "date", required: true }] }];
const on = { available: true } as const;
const off = (reason: "off" | "unverified" | "spend_cap") => ({ available: false, reason }) as const;
const html = (ai: StudioAi) => renderToStaticMarkup(createElement(NewAgreement, { kinds, ai }));
const esc = (s: string) => s.replace(/'/g, "&#x27;");

describe("Studio form: AI controls follow the server's state", () => {
  it("available: the button and the wording notes are offered, no notice", () => {
    const h = html({ suggest: on, draft: on });
    expect(h).toContain("Fill details with Claude AI");
    expect(h).toContain("Wording notes (optional)");
    for (const t of Object.values(AI_UNAVAILABLE)) expect(h).not.toContain(esc(t));
    expect(aiBadge({ suggest: on, draft: on })).toEqual({ tone: "ok", text: "AI on" });
  });

  for (const reason of ["off", "unverified", "spend_cap"] as const) {
    it(`${reason}: no button, no wording notes, one fixed notice`, () => {
      const h = html({ suggest: off(reason), draft: off(reason) });
      expect(h).not.toContain("Fill details with Claude AI");
      expect(h).not.toContain("Wording notes");
      expect(h.split(esc(AI_UNAVAILABLE[reason])).length - 1).toBe(1);
      expect(h).toContain("Generate draft"); // the template path always works
      expect(aiBadge({ suggest: off(reason), draft: off(reason) }).text).not.toBe("AI on");
    });
  }

  it("the notices are the fixed texts", () => {
    expect(AI_UNAVAILABLE.unverified).toBe("Confirm your email address to use the AI assistant.");
    expect(AI_UNAVAILABLE.spend_cap).toBe("The AI assistant has reached today's spending limit.");
    expect(aiBadge({ suggest: off("off"), draft: off("off") }).text).toBe("AI off: templates only");
  });

  it("only rewording over the limit: the button stays, the wording notes give way to the notice", () => {
    const h = html({ suggest: on, draft: off("spend_cap") });
    expect(h).toContain("Fill details with Claude AI");
    expect(h).not.toContain("Wording notes");
    expect(h).toContain(esc(AI_UNAVAILABLE.spend_cap));
    expect(aiBadge({ suggest: on, draft: off("spend_cap") }).text).toBe("AI paused: daily limit reached");
  });
});

describe("Studio form: AI is obvious, honest about what it does, and its suggestions are marked", () => {
  it("the AI panel has the heading, the plain-English prompt, the Claude button and the honest footnote", async () => {
    const { AI_COPY } = await import("@/components/studio/ai-state");
    const h = html({ suggest: on, draft: on });
    for (const t of [AI_COPY.heading, AI_COPY.intro, AI_COPY.inputLabel, AI_COPY.button]) expect(h).toContain(esc(t));
    expect(h).toContain(esc(AI_COPY.footnote));
    expect(AI_COPY.footnote).toMatch(/doesn't write a custom agreement/);
    expect(h).toContain("Agreement details"); // the manual form is still there
    expect(h).toContain("Generate draft");
  });
  it("without AI the AI panel isn't shown, only the reason, and the manual form still works", async () => {
    const { AI_COPY } = await import("@/components/studio/ai-state");
    const h = html({ suggest: off("off"), draft: off("off") });
    expect(h).not.toContain(esc(AI_COPY.heading));
    expect(h).toContain("Agreement details");
  });
  it("a field Claude filled is labelled as its suggestion; one the person filled is not", async () => {
    const { FormField } = await import("@/components/studio/NewAgreement");
    const a = renderToStaticMarkup(createElement(FormField, { label: "Start date", suggested: true }, createElement("input")));
    const b = renderToStaticMarkup(createElement(FormField, { label: "Start date", suggested: false }, createElement("input")));
    expect(a).toContain("Suggested by Claude");
    expect(b).not.toContain("Suggested by Claude");
  });
  it("suggestionToForm marks exactly what Claude stated, drops terms the agreement type doesn't have, and says so", async () => {
    const { suggestionToForm } = await import("@/components/studio/NewAgreement");
    const sg = { kind: "nda", parties: [{ role: "disclosing party", name: "Northwind Advisory LLC" }, { role: "Receiving Party", name: "" }], terms: { startDate: "2027-02-01", fee: "$5,000" }, unclear: [] } as never;
    const f = suggestionToForm(sg, kinds, kinds[0]);
    expect(f.kind).toBe("nda");
    expect(f.names).toEqual({ "Disclosing Party": "Northwind Advisory LLC" });
    expect(f.terms).toEqual({ startDate: "2027-02-01" }); // fee isn't an NDA term
    expect([...f.marked].sort()).toEqual(["kind", "role:Disclosing Party", "term:startDate"]);
    expect(f.result).toMatchObject({ tone: "ok" });
    expect(f.result.text).toMatch(/Claude suggested 3 details/);
    const none = suggestionToForm({ kind: null, parties: [], terms: {}, unclear: [] } as never, kinds, kinds[0]);
    expect(none.marked.size).toBe(0);
    expect(none.result.tone).toBe("error");
  });
});
