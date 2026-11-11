import { describe, expect, it } from "vitest";
import { statusAfterSave } from "@/components/fieldEditorSave";
import type { Field } from "@/lib/fields";

const f = (x: number): Field => ({ id: "f1", type: "signature", role: "client", page: 0, x, y: 0, w: 10, h: 10, label: "Sig", required: true });

describe("statusAfterSave", () => {
  it("is saved when nothing changed during the request", () => {
    const a = [f(1)];
    expect(statusAfterSave(a, a, true)).toBe("saved");
  });
  it("stays dirty when the list changed while the request was in flight", () => {
    expect(statusAfterSave([f(1)], [f(2)], true)).toBe("dirty");
  });
  it("reports failure", () => {
    const a = [f(1)];
    expect(statusAfterSave(a, a, false)).toBe("error");
  });
});
