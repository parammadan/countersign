import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdf } from "@/lib/pdf/extract";
import { DraftValidationError, renderDocument, renderDocx, renderPdf, validateDraft, type DraftDocument } from "@/lib/m23/doc-output";
import { base, drafts, empty, mixed, noClauses, noLocked, noParties } from "./fixtures";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bad = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as unknown as DraftDocument;
const badClause = (c: unknown) => bad({ clauses: [c, { id: "sig", text: "Signed below.", locked: true }] });
const cases: [string, DraftDocument, RegExp][] = [
  ["null draft", null as never, /schema/],
  ["null clause", badClause(null), /object/],
  ["array clause", badClause([]), /object/],
  ["clause without id", badClause({ text: "x" }), /id/],
  ["clause without text", badClause({ id: "a" }), /no text/],
  ["numeric heading", badClause({ id: "a", text: "x", heading: 5 }), /heading/],
  ["numeric number", badClause({ id: "a", text: "x", number: 5 }), /number/],
  ["non-boolean locked", badClause({ id: "a", text: "x", locked: "yes" }), /locked/],
  ["missing parties", bad({ parties: undefined }), /arrays/],
  ["null party", bad({ parties: [null] }), /party/],
  ["party without name", bad({ parties: [{ role: "x" }] }), /party/],
  ["missing origin", bad({ origin: undefined }), /origin/],
  ["unknown origin kind", bad({ origin: { kind: "other" } }), /origin/],
  ["non-string versionId", bad({ origin: { kind: "edit", versionId: 3 } }), /versionId/],
  ["blank title", bad({ title: " " }), /title/],
  ["wrong schema", bad({ schema: 2 }), /schema/],
];

describe("validation in every entry point", () => {
  for (const [name, d, re] of cases) {
    it(`${name}: typed error, no TypeError`, async () => {
      expect(() => validateDraft(d)).toThrow(DraftValidationError);
      expect(() => renderDocx(d)).toThrow(DraftValidationError);
      await expect(renderPdf(d)).rejects.toBeInstanceOf(DraftValidationError);
      await expect(renderDocument(d, "pdf")).rejects.toThrow(re);
      await expect(renderDocument(d, "docx")).rejects.toThrow(re);
    });
  }
  it("accepts a valid origin with a versionId", () => {
    expect(() => validateDraft({ ...base, origin: { kind: "edit", versionId: "v1" } })).not.toThrow();
  });
});

describe("unsignable drafts are refused (D3)", () => {
  const unsignable: [string, DraftDocument, string][] = [
    ["zero parties", noParties, "no_parties"],
    ["zero parties and clauses", empty, "no_parties"],
    ["zero clauses", noClauses, "no_clauses"],
    ["locked signature clause dropped", noLocked, "no_locked_clause"],
  ];
  for (const [name, d, code] of unsignable) {
    it(`${name}: ${code} in every entry point`, async () => {
      const codeOf = async (f: () => unknown) => { try { await f(); } catch (e) { return e instanceof DraftValidationError ? e.code : `untyped ${e}`; } return "accepted"; };
      expect(await codeOf(() => validateDraft(d))).toBe(code);
      expect(await codeOf(() => renderDocx(d))).toBe(code);
      expect(await codeOf(() => renderPdf(d))).toBe(code);
      expect(await codeOf(() => renderDocument(d, "pdf"))).toBe(code);
      expect(await codeOf(() => renderDocument(d, "docx"))).toBe(code);
    });
  }
});

// Independent DOCX check: python3's zipfile and xml.dom.minidom, a different code path from zip.ts.
function parse(bytes: Uint8Array): { parts: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "docx-"));
  try {
    const f = join(dir, "x.docx");
    writeFileSync(f, bytes);
    const script = [
      "import sys, json, zipfile",
      "from xml.dom import minidom",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "out = {}",
      "for i in z.infolist():",
      "    assert i.date_time == (1980, 1, 1, 0, 0, 0), i.date_time",
      "    data = z.read(i.filename)",
      "    minidom.parseString(data)",
      "    out[i.filename] = data.decode('utf-8')",
      "print(json.dumps(out))",
    ].join("\n");
    const r = spawnSync("python3", ["-I", "-c", script, f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`python check failed: ${r.stderr}`);
    return { parts: JSON.parse(r.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
let hasPython = true;
try { execFileSync("python3", ["--version"], { stdio: "ignore" }); } catch { hasPython = false; }

describe.skipIf(!hasPython)("DOCX validated by an independent parser (python3 zipfile + minidom)", () => {
  const more: Record<string, DraftDocument> = {
    ...drafts,
    // Control characters are refused now (harden-limits.test.ts); VT/FF, zero-width and markup stay valid XML.
    ctrl: { ...base, title: "T\u000b\u000c & <x>", clauses: [{ id: "a", text: "vt\u000bff\u000cchar \u200b\ufeff & <b> \"q\" \t tab\nnl", locked: true }] },
    unicode: { ...base, parties: [{ role: "Réle", name: "中文 \u{1F600}" }] },
  };
  for (const [name, d] of Object.entries(more)) {
    it(`every part of "${name}" is a valid zip entry and well-formed XML`, () => {
      const { parts } = parse(renderDocx(d));
      expect(Object.keys(parts)).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "docProps/core.xml"]);
    });
  }
  it("round-trips clause text through the independent parser", () => {
    const x = parse(renderDocx(base)).parts["word/document.xml"];
    expect(x).toContain("Payment is due in 30 days &amp; no later. &lt;ok&gt;");
  });
});

// SHA-256 over each DOCX part's name and UNCOMPRESSED bytes. The zipped bytes depend on the node:zlib
// version (the old whole-file hashes failed on zlib 1.2.12), the XML does not.
function docxPartsSha(buf: Uint8Array): string {
  const b = Buffer.from(buf);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const h = createHash("sha256");
  for (let i = 0; i < n; i++) {
    const cs = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const lnl = b.readUInt16LE(off + 26), lel = b.readUInt16LE(off + 28);
    h.update(b.subarray(p + 46, p + 46 + nl)).update("\0").update(inflateRawSync(b.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + cs))).update("\0");
    p += 46 + nl + el + cl;
  }
  return h.digest("hex");
}

describe("output is unchanged from the pre-optimisation renderer", () => {
  // PDF: SHA-256 of the file from the renderer before winAnsi was changed (commit d8ba499); pdf-lib compresses
  // with pako (pure JS), so these hold in any environment. DOCX: docxPartsSha of the output at 08ec5df.
  // noClauses is refused now (D3), so it has no hash; mixed marks m2 locked, which does not change output.
  const PDF: Record<string, string> = {
    base: "8f2583dcfee2d1f686cfd4ef442cf2f792168dd077031095cab10b63c6864b6c",
    mixed: "575b91b7f87f3ca074b8bb00340af99ae4c6b42ed15311c94e0794c353c81334",
  };
  const DOCX: Record<string, string> = {
    base: "841f04862b078fbdf179f68eab6e595e6cca8d472e6e7f24eec6757b44b5e39a",
    mixed: "49ce9a0093099fa5f86a08d077adf8015444ebcde5c178021357e51c064d3166",
  };
  for (const k of Object.keys(PDF)) {
    it(`${k}: PDF hash and DOCX part hashes unchanged`, async () => {
      expect(sha(await renderPdf(drafts[k]))).toBe(PDF[k]);
      expect(docxPartsSha(renderDocx(drafts[k]))).toBe(DOCX[k]);
    });
  }
  it("zipped DOCX bytes are identical across runs in one environment", () => {
    for (const d of Object.values(drafts)) expect(sha(renderDocx(d))).toBe(sha(renderDocx(structuredClone(d))));
  });
  it("mixed text still shows ? for unencodable characters", async () => {
    const e = await extractPdf(await renderPdf(mixed));
    expect(e.pages.flatMap((p) => p.items.map((i) => i.str)).join(" ")).toContain("Price 5 ? ? ?");
  });
});

describe.runIf(process.env.PERF === "1")("performance (PERF=1)", () => {
  it("renders a large document with unencodable text in reasonable time", async () => {
    const para = "Clause text with café 中文 \u{1F600} and plenty of ordinary words to wrap. ".repeat(40);
    // 300 clauses, ~800,000 characters (400 clauses, 1,056,000, are now over LIMITS.maxTotalChars).
    const big: DraftDocument = { ...base, clauses: Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, heading: `Heading ${i}`, text: para, locked: i === 299 })) };
    const t0 = performance.now();
    const bytes = await renderPdf(big);
    const ms = performance.now() - t0;
    console.log(`PERF renderPdf 300 clauses, ${bytes.length} bytes: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
