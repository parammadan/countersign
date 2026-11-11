// PDF pipeline geometry: certificate text must stay inside the page margins; stamped text must stay inside its field.
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { extractPdf } from "../lib/pdf/extract";
import { appendCertificate, stampFields, type CertInfo, type StampValue } from "../lib/pdf/stamp";
import type { Field } from "../lib/fields";

async function blank() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

const info = (over: Partial<CertInfo>): CertInfo => ({
  envelopeId: "env_test",
  documentName: "Agreement",
  firmName: "Example Firm",
  originalSha256: "a".repeat(64),
  clientSignedSha256: "b".repeat(64),
  parties: [{ role: "Client", name: "Test Person", email: "test@example.test", signedAt: "2026-01-01T00:00:00Z" }],
  events: [],
  verifyUrl: "https://example.test/verify",
  ...over,
});

describe("certificate layout", () => {
  it("breaks a single unbroken token wider than the page instead of running off it", async () => {
    const longName = "X".repeat(150);
    const out = await appendCertificate(await blank(), info({ documentName: longName, parties: [{ role: "Client", name: "Test", email: `${"y".repeat(120)}@example.test`, signedAt: "2026-01-01" }] }));
    const ex = await extractPdf(out);
    const cert = ex.pages[ex.pages.length - 1];
    for (const it of cert.items) expect(it.x + it.w, it.str).toBeLessThanOrEqual(612 - 54 + 1);
  });
});

describe("stamped text fit", () => {
  const f: Field = { id: "f1", type: "text", role: "client", page: 0, x: 100, y: 100, w: 80, h: 40, label: "t", required: false };
  it("keeps a long value inside its field box", async () => {
    const text = "Alexandria Montgomery-Livingston the Third";
    const out = await stampFields(await blank(), [f], new Map<string, StampValue>([["f1", { kind: "text", text }]]));
    const ex = await extractPdf(out);
    const items = ex.pages[0].items.filter((i) => i.str.trim());
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.str).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, "")); // every character kept
    for (const it of items) {
      expect(it.x + it.w).toBeLessThanOrEqual(f.x + f.w + 1);
      expect(it.y).toBeGreaterThanOrEqual(f.y - 1);
      expect(it.y + it.h).toBeLessThanOrEqual(f.y + f.h + 2);
    }
  });
});
