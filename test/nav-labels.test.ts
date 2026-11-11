// The sidebar (desktop and the mobile menu share it) groups the AI pages under "AI & Intelligence", same items, same order.
import { describe, expect, it } from "vitest";
import { visibleNav } from "@/lib/nav";

describe("navigation", () => {
  it("labels the AI section 'AI & Intelligence' and keeps its items and order", () => {
    const g = visibleNav("owner").find((x) => x.section === "intelligence")!;
    expect(g.label).toBe("AI & Intelligence");
    expect(g.items.map((i) => i.label)).toEqual(["Agreement Studio", "Knowledge Hub", "Clause Library", "Document Intelligence"]);
  });
});
