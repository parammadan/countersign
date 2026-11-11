// What a draft doesn't contain ("can't include"), kept with the draft: workspace-scoped, bounded, plain text only.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-disclose-"));

describe("draft disclosures", async () => {
  const D = await import("../lib/drafts/disclosures");
  it("are kept for the draft's own workspace only", () => {
    D.saveDisclosures("ws_a", "drf_1", [{ label: "Other", text: "Travel expenses over $500 need the Client's written approval." }]);
    expect(D.draftDisclosures("ws_a", "drf_1")).toEqual([{ label: "Other", text: "Travel expenses over $500 need the Client's written approval." }]);
    expect(D.draftDisclosures("ws_b", "drf_1")).toEqual([]);
    expect(D.draftDisclosures("ws_a", "drf_other")).toEqual([]);
  });
  it("keep only bounded plain strings; malformed items are dropped; nothing is stored for an empty list", () => {
    D.saveDisclosures("ws_a", "drf_2", [{ label: "A".repeat(200), text: "line\nbreak\u0007 and " + "x".repeat(1_000) }, { label: 5, text: null }, "raw", ...Array.from({ length: 20 }, (_, i) => ({ label: "L", text: `item ${i}` }))]);
    const got = D.draftDisclosures("ws_a", "drf_2");
    expect(got.length).toBeLessThanOrEqual(12);
    expect(got[0].label.length).toBe(60);
    expect(got[0].text.length).toBe(400);
    expect(got[0].text).not.toMatch(/[\n\u0007]/);
    D.saveDisclosures("ws_a", "drf_3", []);
    D.saveDisclosures("ws_a", "drf_3", "not a list");
    expect(D.draftDisclosures("ws_a", "drf_3")).toEqual([]);
  });
});
