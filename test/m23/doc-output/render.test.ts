import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { extractPdf } from "@/lib/pdf/extract";
import { renderDocument, renderDocx, renderPdf, type DraftDocument } from "@/lib/m23/doc-output";
import { crc32 } from "@/lib/m23/doc-output/zip";

const LONG = Array.from({ length: 260 }, (_, i) => `word${i}`).join(" ") + ".";
const doc: DraftDocument = {
  schema: 1,
  title: "Services Agreement",
  parties: [
    { role: "Firm", name: "Example Firm LLP" },
    { role: "Client", name: "Alex Example" },
  ],
  clauses: [
    { id: "c1", heading: "Scope", text: "The Firm will provide the services described in the engagement." },
    { id: "c2", number: "2.1", heading: "Fees", text: "Fees are billed monthly.\nPayment is due in 30 days & no later. <ok>" },
    { id: "c3", heading: "Term", text: LONG, locked: true },
    { id: "c4", text: "Governing law is the law of Exampleland." },
  ],
  origin: { kind: "generated" },
};
const many: DraftDocument = {
  ...doc,
  clauses: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, heading: `Heading ${i}`, text: `Clause body number ${i} ` + "filler text ".repeat(40) + `END${i}`, locked: i === 39 })),
};

function unzip(buf: Uint8Array): Record<string, string> {
  const b = Buffer.from(buf);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    expect(b.readUInt32LE(p)).toBe(0x02014b50);
    const crc = b.readUInt32LE(p + 16), cs = b.readUInt32LE(p + 20), us = b.readUInt32LE(p + 24);
    const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nl).toString("utf8");
    const lnl = b.readUInt16LE(off + 26), lel = b.readUInt16LE(off + 28);
    const data = inflateRawSync(b.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + cs));
    expect(data.length).toBe(us);
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString("utf8");
    p += 46 + nl + el + cl;
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
async function pdfText(bytes: Uint8Array) {
  const ex = await extractPdf(bytes);
  return { pages: ex.pages.map((pg) => norm(pg.items.map((i) => i.str).join(" "))), all: norm(ex.pages.flatMap((pg) => pg.items.map((i) => i.str)).join(" ")) };
}

describe("PDF", () => {
  it("contains every clause exactly once, in order, with headings and numbering", async () => {
    const { all } = await pdfText(await renderPdf(doc));
    let from = 0;
    for (const s of ["1. Scope", doc.clauses[0].text, "2.1 Fees", "Fees are billed monthly.", "Payment is due in 30 days & no later. <ok>", "3. Term", LONG, "4. " + doc.clauses[3].text]) {
      const at = all.indexOf(norm(s), from);
      expect(at, s.slice(0, 30)).toBeGreaterThanOrEqual(from);
      from = at + norm(s).length;
    }
    for (const c of doc.clauses) for (const line of c.text.split("\n")) expect(all.split(norm(line)).length - 1, line.slice(0, 30)).toBe(1);
  });

  it("has a party block and a signature block after the last clause", async () => {
    const { all } = await pdfText(await renderPdf(doc));
    // the party table: each role as a label over its legal name and defined term, before the first clause
    expect(all).toContain("FIRM Example Firm LLP (the \u201cFirm\u201d)");
    expect(all).toContain("CLIENT Alex Example (the \u201cClient\u201d)");
    expect(all.indexOf("Parties")).toBeLessThan(all.indexOf("1. Scope"));
    const sig = all.indexOf("Signatures");
    expect(sig).toBeGreaterThan(all.indexOf(norm(doc.clauses[3].text)));
    expect(all.indexOf("Signed for Example Firm LLP (Firm)")).toBeGreaterThan(sig);
    expect(all.indexOf("Signed for Alex Example (Client)")).toBeGreaterThan(all.indexOf("Signed for Example Firm LLP (Firm)"));
  });

  it("breaks long content over pages without losing or reordering text", async () => {
    const bytes = await renderPdf(many);
    const { pages, all } = await pdfText(bytes);
    expect(pages.length).toBeGreaterThan(3);
    let from = 0;
    for (let i = 0; i < 40; i++) {
      const at = all.indexOf(`Heading ${i} `, from);
      expect(at).toBeGreaterThanOrEqual(from);
      expect(all.indexOf(`END${i}`, at)).toBeGreaterThan(at);
      from = all.indexOf(`END${i}`, at);
    }
    expect(await (await PDFDocument.load(bytes)).getPageCount()).toBe(pages.length);
  });

  it("keeps the signature block on a single page", async () => {
    const ex = await extractPdf(await renderPdf(many));
    const holding = ex.pages.filter((pg) => pg.items.some((i) => i.str.startsWith("Signed for")));
    expect(holding.length).toBe(1);
    expect(holding[0].items.filter((i) => i.str.startsWith("Signed for")).length).toBe(2);
    expect(holding[0].items.some((i) => i.str === "Signatures")).toBe(true);
  });

  it("keeps the signature block whole for every body length (boundary sweep)", async () => {
    for (let n = 1; n <= 60; n++) {
      const d = { ...doc, clauses: [{ id: "x", text: Array.from({ length: n }, (_, i) => `line ${i}`).join("\n"), locked: true }] };
      const ex = await extractPdf(await renderPdf(d));
      const sigPages = ex.pages.filter((pg) => pg.items.some((i) => i.str === "Signatures" || i.str.startsWith("Signed for") || i.str === "Signature" || i.str.startsWith("Name:") || i.str.startsWith("Date:")));
      expect(sigPages.length, `n=${n}`).toBe(1);
      const strs = sigPages[0].items.map((i) => i.str);
      expect(strs.filter((t) => t === "Signature").length, `n=${n}`).toBe(2);
      expect(strs.filter((t) => t.startsWith("Date:")).length, `n=${n}`).toBe(2);
    }
  });

  it("treats CR, CRLF and LF alike and keeps newlines out of single-line fields", async () => {
    const d = { ...doc, title: "T\nU", clauses: [{ id: "x", text: "a\r\nb\rc\nd", locked: true }] };
    const { all } = await pdfText(await renderPdf(d));
    expect(all).toContain("T U");
    expect(all).toContain("a b c d");
    expect(all).not.toContain("?");
  });

  it("splits a single over-wide word instead of overflowing", async () => {
    const d = { ...doc, clauses: [{ id: "x", text: "A".repeat(300), locked: true }] };
    const ex = await extractPdf(await renderPdf(d));
    expect(ex.pages[0].items.every((i) => i.x + i.w <= 612 - 72 + 2)).toBe(true);
    expect(ex.pages.flatMap((p) => p.items.map((i) => i.str)).filter((t) => /^A+$/.test(t)).join("").length).toBe(300);
  });

  it("replaces unencodable characters visibly rather than throwing", async () => {
    const d = { ...doc, clauses: [{ id: "x", text: "Price 5 \u4e2d \u6587", locked: true }] };
    const { all } = await pdfText(await renderPdf(d));
    expect(all).toContain("Price 5 ? ?");
  });
});

describe("DOCX", () => {
  const parts = unzip(renderDocx(doc));
  it("is a well-formed package with the required parts", () => {
    expect(Object.keys(parts)).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "docProps/core.xml"]);
    expect(Buffer.from(renderDocx(doc)).subarray(0, 2).toString()).toBe("PK");
    for (const [n, x] of Object.entries(parts)) {
      expect(x.startsWith("<?xml"), n).toBe(true);
      const tags = x.match(/<\/?[A-Za-z][^>]*>/g)!.filter((t) => !t.startsWith("<?"));
      const stack: string[] = [];
      for (const t of tags) {
        const name = t.replace(/^<\/?([^\s/>]+)[\s\S]*$/, "$1");
        if (t.endsWith("/>")) continue;
        if (t.startsWith("</")) expect(stack.pop(), n).toBe(name);
        else stack.push(name);
      }
      expect(stack, n).toEqual([]);
    }
  });
  it("keeps clauses once, in order, escaped, with numbering and signature block", () => {
    const x = parts["word/document.xml"];
    const text = norm(x.replace(/<w:br\/>|<\/w:p>/g, " ").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    let from = 0;
    for (const s of ["Services Agreement", "Parties", "Firm: Example Firm LLP", "1. Scope", doc.clauses[0].text, "2.1 Fees", "Fees are billed monthly.", "Payment is due in 30 days & no later. <ok>", "3. Term", LONG, "4. " + doc.clauses[3].text, "Signatures", "Signed for Example Firm LLP (Firm)", "Signed for Alex Example (Client)"]) {
      const at = text.indexOf(norm(s), from);
      expect(at, s.slice(0, 30)).toBeGreaterThanOrEqual(from);
      from = at + norm(s).length;
    }
    expect(text.split(LONG).length - 1).toBe(1);
    expect(x).toContain("&amp;");
    expect(x).not.toContain("& no later");
  });
  it("refuses XML-illegal control characters instead of deleting them", () => {
    expect(() => renderDocx({ ...doc, clauses: [{ id: "a", text: "bad\u0001char", locked: true }] })).toThrow(/control, format or invalid character/);
  });
});

describe("determinism", () => {
  it("same input gives byte-identical PDF and DOCX", async () => {
    expect(Buffer.from(await renderPdf(doc)).equals(Buffer.from(await renderPdf(structuredClone(doc))))).toBe(true);
    expect(Buffer.from(renderDocx(doc)).equals(Buffer.from(renderDocx(structuredClone(doc))))).toBe(true);
  });
  it("different input gives different output", async () => {
    const other = { ...doc, title: "Other" };
    expect(Buffer.from(await renderPdf(doc)).equals(Buffer.from(await renderPdf(other)))).toBe(false);
  });
  it("fixed metadata dates", async () => {
    const p = await PDFDocument.load(await renderPdf(doc), { updateMetadata: false });
    expect(p.getCreationDate()?.getTime()).toBe(0);
    expect(p.getModificationDate()?.getTime()).toBe(0);
  });
});

describe("renderDocument", () => {
  it("returns content type and filename", async () => {
    const a = await renderDocument(doc, "pdf");
    expect(a.contentType).toBe("application/pdf");
    expect(a.filename).toBe("services-agreement.pdf");
    expect((await renderDocument(doc, "docx")).filename).toBe("services-agreement.docx");
  });
  it("rejects bad drafts", async () => {
    await expect(renderDocument({ ...doc, schema: 2 as never }, "pdf")).rejects.toThrow();
    await expect(renderDocument({ ...doc, title: "  " }, "docx")).rejects.toThrow();
    await expect(renderDocument({ ...doc, parties: undefined } as never, "pdf")).rejects.toThrow(/arrays/);
    await expect(renderDocument({ ...doc, parties: [{ role: "x" }] } as never, "pdf")).rejects.toThrow(/party/);
  });
});
