import { spawn } from "node:child_process";
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

// Word-family files are sniffed by content, not trusted by extension, before LibreOffice sees them.
export function looksLike(data: Buffer, ext: string): boolean {
  const head = data.subarray(0, 8);
  if (ext === ".docx" || ext === ".odt") return head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (ext === ".doc") return head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (ext === ".rtf") return data.subarray(0, 5).toString("latin1") === "{\\rtf";
  return false;
}

export async function toPdf(data: Buffer, filename: string): Promise<Buffer> {
  const ext = path.extname(filename).toLowerCase();
  const isPdf = data.subarray(0, 5).toString("latin1") === "%PDF-";
  let pdf: Buffer;
  if (isPdf) {
    pdf = data;
  } else if (WORD_EXT.includes(ext)) {
    if (!looksLike(data, ext)) throw new ConvertError(`This file isn't a real ${ext} document. Open it in Word and save it again, or export a PDF.`);
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
  // Fillable form fields would sit on top of (and hide) our stamps: flatten them into the page.
  try {
    const form = doc.getForm();
    if (form.getFields().length) form.flatten();
  } catch {
    /* unusual form structures: keep the document as is */
  }
  // Re-save: collapses incremental updates so the stamping base is a single clean revision.
  try {
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch {
    throw new ConvertError("This PDF is damaged and couldn't be processed. Try exporting it again.");
  }
}

// At most two conversions at once: LibreOffice is memory-hungry and the box is small.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function convertWithLibreOffice(data: Buffer, ext: string): Promise<Buffer> {
  if (waiting.length > 10) throw new ConvertError("We're converting a lot of documents right now. Try again in a minute, or upload a PDF.");
  // In the Docker image, conversion runs in a separate service under its own user, which can't read /data.
  return slot(() => (process.env.CONVERTER_URL ? convertRemote(data, ext, process.env.CONVERTER_URL) : convertOnce(data, ext)));
}

async function convertRemote(data: Buffer, ext: string, base: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Ext": ext },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new ConvertError("Word conversion isn't available right now. Upload a PDF instead, or try again in a minute.");
  }
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  if (res.status === 504) throw new ConvertError("Converting this Word document took too long. Save it as PDF and upload that.");
  if (res.status === 503) throw new ConvertError("Word conversion isn't available on this server. Upload a PDF instead.");
  throw new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that.");
}

async function convertOnce(data: Buffer, ext: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-conv-"));
  const input = path.join(dir, "input" + ext);
  await fs.writeFile(input, data);
  const profile = "file://" + path.join(dir, "profile-" + token(6));
  try {
    await new Promise<void>((resolve, reject) => {
      // Own process group, so a timeout kills soffice.bin too (soffice is a wrapper that forks it).
      // No app secrets in its environment; its profile lives in the temp dir.
      const child = spawn(soffice(), [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, input], {
        detached: true,
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "en_US.UTF-8", SAL_USE_VCLPLUGIN: "svp" } as unknown as NodeJS.ProcessEnv,
      });
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        killGroup();
        reject(new ConvertError("Converting this Word document took too long. Save it as PDF and upload that."));
      }, 60_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") reject(new ConvertError("Word conversion isn't available on this server. Upload a PDF instead."));
        else reject(new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that."));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        killGroup(); // reap any stragglers
        if (code === 0) resolve();
        else reject(new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that."));
      });
    });
    return await fs.readFile(path.join(dir, "input.pdf"));
  } catch (e) {
    if (e instanceof ConvertError) throw e;
    throw new ConvertError("We couldn't convert this Word document. Save it as PDF and upload that.");
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
