// L1: Word uploads were trusted on file extension alone. Content must match before LibreOffice is started.
import { describe, it, expect } from "vitest";
import { toPdf, looksLike, ConvertError } from "../lib/convert";

process.env.SOFFICE_PATH = "/nonexistent/soffice-must-not-run";

describe("Word upload sniffing", () => {
  for (const name of ["x.docx", "x.odt", "x.doc", "x.rtf"])
    it(`${name} with the wrong content is refused before conversion`, async () => {
      const e = await toPdf(Buffer.from("MZ not a document at all"), name).catch((x) => x);
      expect(e).toBeInstanceOf(ConvertError);
      expect(String(e.message)).toMatch(/isn't a real/);
    });
  it("accepts the real signatures", () => {
    expect(looksLike(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), ".docx")).toBe(true);
    expect(looksLike(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), ".doc")).toBe(true);
    expect(looksLike(Buffer.from("{\\rtf1\\ansi"), ".rtf")).toBe(true);
  });
  it("a zip is not an old .doc", () => expect(looksLike(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), ".doc")).toBe(false));
});
