// Fixes for the S11 red-team findings D1-D5 (scratchpad sbx-findings.md, test/redteam/docoutput.redteam.test.ts
// on claude/S11-redteam). Each FINDING input from there is reproduced here and must now fail closed.
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdf } from "@/lib/pdf/extract";
import { DraftValidationError, LIMITS, renderDocument, renderDocx, renderPdf, validateDraft, type DraftDocument } from "@/lib/m23/doc-output";

const SIG = { id: "c3", heading: "Signatures", text: "Each party signs below.", locked: true };
const base = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  schema: 1,
  title: "Services Agreement",
  parties: [{ role: "Provider", name: "Northwind Advisory LLC" }, { role: "Client", name: "Maple Row Studio Ltd" }],
  clauses: [
    { id: "c1", heading: "Scope", text: "Provider will perform the services." },
    { id: "c2", heading: "Fees", text: "Client will pay $1,500 per month." },
    SIG,
  ],
  origin: { kind: "generated" },
  ...over,
});
const withText = (text: string) => base({ clauses: [{ id: "c", text }, SIG] });

/** The DraftValidationError code each entry point gives, or "accepted" / "untyped ..." . */
async function codes(d: DraftDocument): Promise<string[]> {
  const one = async (f: () => unknown) => {
    try { await f(); } catch (e) { return e instanceof DraftValidationError ? e.code : `untyped ${e}`; }
    return "accepted";
  };
  return [
    await one(() => validateDraft(d)),
    await one(() => renderPdf(d)),
    await one(() => renderDocx(d)),
    await one(() => renderDocument(d, "pdf")),
    await one(() => renderDocument(d, "docx")),
  ];
}
const all = (code: string) => [code, code, code, code, code];

function docxXml(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < b.readUInt16LE(eocd + 10); i++) {
    const cs = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    if (b.subarray(p + 46, p + 46 + nl).toString() === "word/document.xml") {
      const s = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
      return inflateRawSync(b.subarray(s, s + cs)).toString("utf8");
    }
    p += 46 + nl + el + cl;
  }
  throw new Error("no document.xml");
}
// Visible DOCX text; a line break or paragraph end reads as "\n".
const docxText = (d: DraftDocument) => [...docxXml(renderDocx(d)).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\/>|<\/w:p>/g)].map((m) => m[1] ?? "\n").join("");
const pdfLines = async (d: DraftDocument) => (await extractPdf(await renderPdf(d))).pages.flatMap((p) => p.items);

describe("D1: long tokens and oversized input never hang", () => {
  it("a 20,000-character unbroken token renders to PDF in under 1 s, split at the width, nothing lost", async () => {
    const token = "x".repeat(20_000);
    const t0 = performance.now();
    const bytes = await renderPdf(withText(token));
    expect(performance.now() - t0).toBeLessThan(1_000); // the old shrink-by-one splitter took minutes
    const items = (await extractPdf(bytes)).pages.flatMap((p) => p.items).filter((i) => /^x+$/.test(i.str));
    expect(items.map((i) => i.str).join("")).toBe(token);
    expect(items.every((i) => i.x + i.w <= 612 - 72 + 2)).toBe(true);
  });

  it("the same token in the title and a party name (bold, larger fonts) is also fast", async () => {
    const token = "W".repeat(1_000); // LIMITS.maxFieldChars
    const t0 = performance.now();
    await renderPdf(base({ title: token, parties: [{ role: "Provider", name: token }, { role: "Client", name: "C" }] }));
    expect(performance.now() - t0).toBeLessThan(300); // ~1.5 s with the old splitter
  });

  it("hard-breaks are exact: every piece fits the line and one more character would not", async () => {
    const token = "iWl.mM'".repeat(700);
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const pieces = (await pdfLines(withText(token))).map((i) => i.str).filter((s) => token.includes(s) && s.length > 20);
    expect(pieces.join("")).toBe(token);
    let at = 0;
    for (const [k, s] of pieces.entries()) {
      expect(font.widthOfTextAtSize(s, 11)).toBeLessThanOrEqual(468);
      if (k < pieces.length - 1) expect(font.widthOfTextAtSize(token.slice(at, at + s.length + 1), 11)).toBeGreaterThan(468);
      at += s.length;
    }
  });

  it("a clause at the per-clause limit, one unbroken token, renders in bounded time", async () => {
    const t0 = performance.now();
    const bytes = await renderPdf(withText("W".repeat(LIMITS.maxClauseChars)));
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(50);
  });

  it("a 2 MB document is refused with a typed too_large error, quickly, in every entry point", async () => {
    const big = base({ clauses: [...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, text: "word ".repeat(40_000) })), SIG] });
    const t0 = performance.now();
    expect(await codes(big)).toEqual(all("too_large"));
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("the S11 inputs are refused: a 3 MB clause, 2,000 parties", async () => {
    expect(await codes(withText("word ".repeat(600_000)))).toEqual(all("too_large"));
    expect(await codes(base({ parties: Array.from({ length: 2000 }, (_, i) => ({ role: "Party", name: `Party ${i}` })) }))).toEqual(all("too_large"));
  });

  it("every other limit is enforced with too_large", async () => {
    const long = "a".repeat(LIMITS.maxFieldChars + 1);
    for (const d of [
      base({ title: long }),
      base({ parties: [{ role: long, name: "A" }] }),
      base({ parties: [{ role: "A", name: long }] }),
      base({ clauses: [{ id: "c", heading: long, text: "x" }, SIG] }),
      base({ clauses: [{ id: "c", number: long, text: "x" }, SIG] }),
      base({ clauses: [{ id: long, text: "x" }, SIG] }),
      base({ origin: { kind: "edit", versionId: long } }),
      base({ clauses: [...Array.from({ length: LIMITS.maxClauses }, (_, i) => ({ id: `c${i}`, text: "x" })), SIG] }),
      withText("a\n".repeat(LIMITS.maxLineBreaks + 1)),
    ]) expect(await codes(d)).toEqual(all("too_large"));
  });

  it("documents exactly at each limit are accepted", async () => {
    const field = "f".repeat(LIMITS.maxFieldChars);
    expect(await codes(withText("x".repeat(LIMITS.maxClauseChars)))).toEqual(all("accepted"));
    expect(await codes(base({ parties: Array.from({ length: LIMITS.maxParties }, (_, i) => ({ role: "Party", name: `P${i}` })) }))).toEqual(all("accepted"));
    expect(await codes(base({ clauses: [...Array.from({ length: LIMITS.maxClauses - 1 }, (_, i) => ({ id: `k${i}`, text: "x" })), SIG] }))).toEqual(all("accepted"));
    expect(await codes(withText("a\n".repeat(LIMITS.maxLineBreaks)))).toEqual(all("accepted"));
    expect(await codes(base({ title: field, parties: [{ role: field, name: field }], clauses: [{ id: "c", number: field, heading: field, text: "x" }, SIG] }))).toEqual(all("accepted"));
    // Exactly LIMITS.maxTotalChars characters in all strings; one more is refused.
    const d = base({ clauses: [...Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, text: "x ".repeat(LIMITS.maxClauseChars / 2) })), SIG] });
    const used = (x: DraftDocument) => [x.title, ...x.parties.flatMap((p) => [p.role, p.name]), ...x.clauses.flatMap((c) => [c.id, c.number ?? "", c.heading ?? "", c.text])].join("").length;
    const n = LIMITS.maxTotalChars - used(d) - "fill".length;
    const fill = { id: "fill", text: "y ".repeat(Math.floor(n / 2)) + (n % 2 ? "y" : "") };
    const atLimit = base({ clauses: [...d.clauses.slice(0, 4), fill, SIG] });
    expect(used(atLimit)).toBe(LIMITS.maxTotalChars);
    expect(await codes(atLimit)).toEqual(all("accepted"));
    expect(await codes(base({ clauses: [...d.clauses.slice(0, 4), { ...fill, text: fill.text + "z" }, SIG] }))).toEqual(all("too_large"));
  }, 60_000);
});

describe("D2: bidi controls refused, zero-width characters stripped the same way in both formats", () => {
  const BIDI = ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"];

  it("the S11 input (U+202E, U+200B, U+2066) is refused", async () => {
    expect(await codes(withText("Client pays ‮000,1$‬ per month. no​t liable⁦x⁩"))).toEqual(all("bidi_control"));
  });

  it("every bidi embedding, override and isolate is refused in every field", async () => {
    for (const ch of BIDI) {
      for (const d of [
        base({ title: `T${ch}` }),
        base({ parties: [{ role: `R${ch}`, name: "A" }] }),
        base({ parties: [{ role: "R", name: `A${ch}` }] }),
        base({ clauses: [{ id: "c", heading: `H${ch}`, text: "x" }, SIG] }),
        base({ clauses: [{ id: "c", number: `1${ch}`, text: "x" }, SIG] }),
        withText(`pays ${ch}100`),
      ]) expect(await codes(d), `U+${ch.codePointAt(0)!.toString(16)}`).toEqual(all("bidi_control"));
    }
  });

  it("zero-width characters are removed from the DOCX and the PDF alike (no '?' in the PDF)", async () => {
    const d = base({
      title: "Services​ Agreement",
      parties: [{ role: "Provider", name: "North﻿wind" }, { role: "Client", name: "Maple⁠ Row" }],
      clauses: [{ id: "c", heading: "Li‌ability", text: "We are no​t liable for x‍y." }, SIG],
    });
    const docx = docxText(d);
    const pdf = (await pdfLines(d)).map((i) => i.str).join("\n");
    for (const s of ["Services Agreement", "Provider: Northwind", "Client: Maple Row", "1. Liability", "We are not liable for xy."]) {
      expect(docx).toContain(s);
      expect(pdf).toContain(s);
    }
    expect(docx).not.toMatch(/[​-‍⁠﻿]/);
    expect(pdf).not.toMatch(/[​-‍⁠﻿?]/);
  });

  it("a title or party name made only of zero-width characters counts as blank", async () => {
    expect((await codes(base({ title: "​​" })))[0]).toBe("invalid");
    expect(await codes(base({ parties: [{ role: "Provider", name: "​" }] }))).toEqual(all("blank_party"));
  });

  it("the caller's document is not modified", async () => {
    const d = base({ title: "A​B" });
    const before = structuredClone(d);
    await renderPdf(d);
    renderDocx(d);
    expect(d).toEqual(before);
  });
});

describe("D3: only signable documents are rendered", () => {
  it("no parties: no_parties", async () => {
    expect(await codes(base({ parties: [], clauses: [{ id: "c1", heading: "Scope", text: "Provider will perform the services.", locked: true }] }))).toEqual(all("no_parties"));
  });
  it("no clauses: no_clauses", async () => {
    expect(await codes(base({ clauses: [] }))).toEqual(all("no_clauses"));
  });
  it("the locked signature clause dropped, or emptied: no_locked_clause", async () => {
    expect(await codes(base({ clauses: base().clauses.filter((c) => !c.locked) }))).toEqual(all("no_locked_clause"));
    expect(await codes(base({ clauses: [{ ...SIG, text: " ​ " }] }))).toEqual(all("no_locked_clause"));
    expect(await codes(base({ clauses: [{ ...SIG, locked: false }] }))).toEqual(all("no_locked_clause"));
  });
  it("a blank party role or name: blank_party", async () => {
    expect(await codes(base({ parties: [{ role: "Provider", name: "  " }] }))).toEqual(all("blank_party"));
    expect(await codes(base({ parties: [{ role: "", name: "A" }] }))).toEqual(all("blank_party"));
  });
  it("a complete document is still accepted", async () => {
    expect(await codes(base())).toEqual(all("accepted"));
  });
});

describe("D4: control characters are refused, never silently deleted", () => {
  it("the S11 input (U+0001 between letters) is refused", async () => {
    expect(await codes(withText("Pay no\u0001t more than 100 dollars"))).toEqual(all("invalid_char"));
  });
  it("C0 (except tab/LF/CR/VT/FF), DEL, C1, U+FFFE/U+FFFF and lone surrogates are refused in any field", async () => {
    for (const ch of ["\u0000", "\u0001", "\u0008", "\u000E", "\u001F", "\u007F", "\u0085", "\u009F", "￾", "￿", "\uD800", "\uDC00"]) {
      expect(await codes(withText(`a${ch}b`)), `U+${ch.charCodeAt(0).toString(16)}`).toEqual(all("invalid_char"));
      expect(await codes(base({ title: `a${ch}b` }))).toEqual(all("invalid_char"));
      expect(await codes(base({ parties: [{ role: "R", name: `a${ch}b` }] }))).toEqual(all("invalid_char"));
    }
  });
  it("a valid surrogate pair (emoji) is accepted", async () => {
    expect(await codes(withText("ok \u{1F600}"))).toEqual(all("accepted"));
  });
  it("VT and FF become line breaks in both formats, so digits are never joined", async () => {
    const d = withText("Pay 10\u000B0 dollars\u000Cnow");
    expect(docxText(d)).toContain("Pay 10\n0 dollars\nnow");
    const strs = (await pdfLines(d)).map((i) => i.str);
    expect(strs).toEqual(expect.arrayContaining(["Pay 10", "0 dollars", "now"]));
    expect(strs.join(" ")).not.toContain("100");
  });
});

describe("D5: clause ids and numbers are unambiguous", () => {
  it("the S11 input (two clauses with id dup, both numbered 1.) is refused", async () => {
    const d = base({ clauses: [
      { id: "dup", number: "1.", heading: "Fees", text: "Client pays $9,000." },
      { id: "dup", number: "1.", heading: "Fees", text: "Client pays $1.", locked: true },
    ] });
    expect(await codes(d)).toEqual(all("duplicate_clause_id"));
  });
  it("two clauses with the same resolved number are refused, including an explicit number equal to a position", async () => {
    expect(await codes(base({ clauses: [{ id: "a", number: "1.", text: "x" }, { id: "b", number: " 1. ", text: "y", locked: true }] }))).toEqual(all("duplicate_clause_number"));
    expect(await codes(base({ clauses: [{ id: "a", text: "x" }, { id: "b", number: "1.", text: "y", locked: true }] }))).toEqual(all("duplicate_clause_number"));
  });
  it("blank clause ids are refused", async () => {
    expect(await codes(base({ clauses: [{ id: " ", text: "x" }, SIG] }))).toEqual(all("invalid"));
  });
});

describe("independent review follow-ups", () => {
  it("bidi marks (LRM, RLM, ALM) are refused: RLM alone makes '1 2' display as '2 1'", async () => {
    for (const ch of ["\u200E", "\u200F", "\u061C"]) expect(await codes(withText(`pays ${ch}1 ${ch}2`))).toEqual(all("bidi_control"));
  });

  it("other invisible format characters are refused: tag characters, invisible operators, digit shapes", async () => {
    for (const ch of ["\u{E0041}", "\u{E0001}", "\u2061", "\u2062", "\u206E", "\u180E", "\uFFF9", "\u0600"]) {
      expect(await codes(withText(`pay 1${ch}00`)), `U+${ch.codePointAt(0)!.toString(16)}`).toEqual(all("invalid_char"));
    }
  });

  it("the soft hyphen is still accepted (WinAnsi has it, so both formats print it)", async () => {
    expect(await codes(withText("indemni\u00ADfication"))).toEqual(all("accepted"));
  });

  it("line breaks in single-line fields become spaces in the DOCX too, so a heading cannot fake a clause", async () => {
    const d = base({
      parties: [{ role: "Provider", name: "Bob\nAlice" }, { role: "Client", name: "C" }],
      clauses: [{ id: "c", heading: "Scope\n\n5. Payment\nClient pays $1", text: "x" }, SIG],
    });
    const docx = docxText(d).split("\n");
    const pdf = (await pdfLines(d)).map((i) => i.str);
    for (const lines of [docx, pdf]) {
      expect(lines).toContain("1. Scope 5. Payment Client pays $1");
      expect(lines).not.toContain("5. Payment");
      expect(lines).toContain("Provider: Bob Alice");
      expect(lines).toContain("Signed for Bob Alice (Provider)");
    }
  });

  it("long whitespace runs in single-line fields render fast (linear flattening)", async () => {
    const blank = " ".repeat(498) + "\n" + " ".repeat(498);
    const d = base({ clauses: [...Array.from({ length: 499 }, (_, i) => ({ id: `k${i}`, number: `${i + 1}${blank}`, heading: `H${blank}`, text: "x" })), { ...SIG, number: "500." }] });
    const t0 = performance.now();
    await renderPdf(d);
    renderDocx(d);
    expect(performance.now() - t0).toBeLessThan(500); // ~1.9 s for the PDF with the old regex
  });

  it("a getter cannot show validation one value and the renderer another", async () => {
    let reads = 0;
    const d = base();
    Object.defineProperty(d, "title", { enumerable: true, get: () => (reads++ < 1 ? "OK" : "\u202Eevil\u0001") });
    const xml = docxXml(renderDocx(d));
    expect(xml).toContain(">OK<"); // rendered from the one value that was validated
    expect(xml).not.toMatch(/\u202E|evil/);
    reads = 0;
    const text = (await pdfLines(d)).map((i) => i.str);
    expect(text).toContain("OK");
    expect(text.join(" ")).not.toContain("evil");
  });

  it("a hole in a sparse clauses array is refused, not skipped", async () => {
    const clauses = [] as DraftDocument["clauses"];
    clauses[1] = SIG;
    expect(await codes(base({ clauses }))).toEqual(all("invalid"));
  });

  it("clause numbers that print alike are duplicates: '1' or fullwidth '１.' next to position '1.'", async () => {
    for (const n of ["1", "１.", "1 .", "1.."]) {
      expect(await codes(base({ clauses: [{ id: "a", text: "x" }, { id: "b", number: n, text: "y", locked: true }] })), n).toEqual(all("duplicate_clause_number"));
    }
    expect(await codes(base({ clauses: [{ id: "a", number: "A.", text: "x" }, { id: "b", number: "a", text: "y", locked: true }] }))).toEqual(all("duplicate_clause_number"));
  });

  it("blank-looking fillers count as blank", async () => {
    expect((await codes(base({ title: "\u3164\u2800" })))[0]).toBe("invalid");
    expect(await codes(base({ parties: [{ role: "Provider", name: "\u115F\u1160" }] }))).toEqual(all("blank_party"));
    expect(await codes(base({ clauses: [{ ...SIG, text: "\uFFA0 \u3164" }] }))).toEqual(all("no_locked_clause"));
  });

  it("error messages never echo unchecked input", async () => {
    for (const d of [
      base({ clauses: [{ id: "\u202Eevil", text: 5 as unknown as string }, SIG] }),
      base({ clauses: [{ id: "\u202Eevil", text: "x", heading: 5 as unknown as string }, SIG] }),
      base({ clauses: [{ id: "dup", text: "x" }, { ...SIG, id: "dup" }] }),
    ]) {
      try { validateDraft(d); throw new Error("accepted"); } catch (e) {
        expect(e).toBeInstanceOf(DraftValidationError);
        expect((e as Error).message).not.toMatch(/evil|dup|\u202E/);
      }
    }
  });
});

describe("second review follow-ups", () => {
  it("a sparse array with a huge length is refused by every entry point without being walked", async () => {
    const clauses = [SIG] as DraftDocument["clauses"];
    clauses.length = 2 ** 31;
    const parties = [{ role: "R", name: "N" }];
    parties.length = 2 ** 31;
    const t0 = performance.now();
    expect(await codes(base({ clauses }))).toEqual(all("too_large"));
    expect(await codes(base({ parties }))).toEqual(all("too_large"));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("U+2028/U+2029 become line breaks in both formats, like VT/FF", async () => {
    const d = withText("Pay 10\u20280 dollars\u2029now");
    expect(docxText(d)).toContain("Pay 10\n0 dollars\nnow");
    expect((await pdfLines(d)).map((i) => i.str)).toEqual(expect.arrayContaining(["Pay 10", "0 dollars", "now"]));
    expect(docxText(base({ title: "A\u2028B" }))).toContain("A B");
  });
});
