import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { token } from "./util";

export class ConvertError extends Error {}

const WORD_EXT = [".docx", ".doc", ".odt", ".rtf"];
export const ACCEPTED = [".pdf", ...WORD_EXT];
export const MAX_UPLOAD = 20 * 1024 * 1024;

function soffice(): string {
  return process.env.SOFFICE_PATH || "soffice";
}

export async function toPdf(data: Buffer, filename: string): Promise<Buffer> {
  const ext = path.extname(filename).toLowerCase();
  const isPdf = data.subarray(0, 5).toString("latin1") === "%PDF-";
  let pdf: Buffer;
  if (isPdf) {
    pdf = data;
  } else if (WORD_EXT.includes(ext)) {
    pdf = await convertWithLibreOffice(data, ext);
  } else {
    throw new ConvertError("Upload a PDF or Word document (.pdf, .docx, .doc, .odt, .rtf).");
  }
  return normalize(pdf);
}

async function normalize(pdf: Buffer): Promise<Buffer> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/encrypt/i.test(msg)) throw new ConvertError("This PDF is password-protected or encrypted. Export an unlocked copy and upload that.");
    throw new ConvertError("This file couldn't be read as a PDF. Try exporting it again from Word or Google Docs.");
  }
  let pages = 0;
  try {
    pages = doc.getPageCount();
  } catch {
    throw new ConvertError("This file couldn't be read as a PDF. Try exporting it again from Word or Google Docs.");
  }
  if (pages === 0) throw new ConvertError("This PDF has no pages.");
  if (pages > 100) throw new ConvertError("Agreements over 100 pages aren't supported.");
  // Re-save: collapses incremental updates so the stamping base is a single clean revision.
  try {
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch {
    throw new ConvertError("This PDF is damaged and couldn't be processed. Try exporting it again.");
  }
}

async function convertWithLibreOffice(data: Buffer, ext: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-conv-"));
  const input = path.join(dir, "input" + ext);
  await fs.writeFile(input, data);
  const profile = "file://" + path.join(dir, "profile-" + token(6));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        /*turbopackIgnore: true*/ soffice(),
        [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, input],
        { timeout: 90_000 },
        (err, _so, se) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") reject(new ConvertError("Word conversion isn't available on this server. Upload a PDF instead."));
            else reject(new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that. " + (se || "").slice(0, 200)));
          } else resolve();
        },
      );
    });
    return await fs.readFile(path.join(dir, "input.pdf"));
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    throw new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that.");
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
