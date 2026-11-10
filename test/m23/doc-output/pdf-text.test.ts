import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfCanPrint, pdfTextProblem, renderDocument, unprintableChars } from "@/lib/m23/doc-output";
import type { DraftDocument } from "@/lib/m23/doc-output";
import { extractPdf } from "@/lib/pdf/extract";

const doc = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  schema: 1, title: "Licence Agreement", origin: { kind: "generated" },
  parties: [{ role: "Licensor", name: "Cedar Mock Inc" }, { role: "Licensee", name: "Sam Fictional" }],
  clauses: [
    { id: "fees", number: "1", heading: "Fees", text: "The Licensee will pay the Licensor a fee of EUR 5,000 \u2014 \u201cnet\u201d." },
    { id: "signatures", number: "2", heading: "Signatures", locked: true, text: "Signed by both parties." },
  ],
  ...over,
});

describe("pdfTextProblem", () => {
  it("agrees with the PDF font's own encoder for every code point up to U+2FFF", async () => {
    const pdf = await PDFDocument.create();
    const fonts = [await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold)];
    const mismatches: string[] = [];
    for (let c = 0x20; c <= 0x2fff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const ch = String.fromCodePoint(c);
      for (const f of fonts) {
        let enc = true;
        try { f.encodeText(ch); } catch { enc = false; }
        if (enc !== pdfCanPrint(ch)) mismatches.push(`U+${c.toString(16)} font=${enc}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
  it("is null for printable documents, accented Latin and typographic punctuation included", () => {
    expect(pdfTextProblem(doc())).toBeNull();
    expect(pdfTextProblem(doc({ parties: [{ role: "Licensor", name: "M\u00fcller Soci\u00e9t\u00e9 \u00a3\u20ac" }] }))).toBeNull();
  });
  it("names the field and the characters the PDF would print as ?", () => {
    expect(pdfTextProblem(doc({ parties: [{ role: "Licensor", name: "\u0141ukasz Nowak" }, doc().parties[1]] }))).toBe("party 1 name: cannot print \u0141 (U+0141)");
    expect(pdfTextProblem(doc({ parties: [doc().parties[0], { role: "Licensee", name: "\u0422\u0435\u0441\u0442" }] }))).toMatch(/^party 2 name: cannot print \u0422 \(U\+0422\), \u0435/);
    expect(pdfTextProblem(doc({ clauses: [{ id: "fees", heading: "Fees", text: "\u20b95,000 or \u2265 2%" }] }))).toBe("clause 1 text: cannot print \u20b9 (U+20B9), \u2265 (U+2265)");
    expect(pdfTextProblem(doc({ title: "\u5951\u7d04" }))).toMatch(/^title: cannot print/);
    expect(pdfTextProblem(doc({ clauses: [{ id: "x", heading: "Gr\u00fc\u00df\u0435", text: "ok" }] }))).toMatch(/^clause 1 heading: cannot print \u0435/);
    // Zero-width characters are removed by both renderers, so they are not "?" in the PDF.
    expect(unprintableChars("a\u200bb")).toEqual([]);
  });
  it("a document it accepts renders without any '?' it did not contain", async () => {
    const d = doc({ parties: [{ role: "Licensor", name: "M\u00fcller Soci\u00e9t\u00e9" }, doc().parties[1]] });
    expect(pdfTextProblem(d)).toBeNull();
    const ex = await extractPdf((await renderDocument(d, "pdf")).bytes);
    expect(ex.pages.flatMap((p) => p.items.map((i) => i.str)).join(" ")).not.toContain("?");
  });
});
