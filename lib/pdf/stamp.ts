// Writes field values and signature images into the agreement, and builds the
// certificate of completion. Coordinates in `Field` are top-left origin points
// relative to the page's crop box (what pdf.js reports), so convert here.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { Field } from "../fields";

export type StampValue = { kind: "text"; text: string } | { kind: "image"; png: Uint8Array } | { kind: "check"; on: boolean };

const INK = rgb(0.05, 0.12, 0.35);

// pdf-lib standard fonts are WinAnsi only. Keep what they can draw, swap the rest.
export function winAnsi(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => {
      const d = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return /^[\x20-\x7E]+$/.test(d) ? d : "?";
    });
}

function box(page: PDFPage, f: Field) {
  const cb = page.getCropBox();
  return { x: cb.x + f.x, y: cb.y + cb.height - f.y - f.h, w: f.w, h: f.h };
}

function fitText(font: PDFFont, text: string, w: number, h: number) {
  let size = Math.min(11, Math.max(6, h * 0.72));
  while (size > 5 && font.widthOfTextAtSize(text, size) > w - 2) size -= 0.5;
  return size;
}

export async function stampFields(pdfBytes: Uint8Array, fields: Field[], values: Map<string, StampValue>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const imgCache = new Map<Uint8Array, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  for (const f of fields) {
    const v = values.get(f.id);
    if (!v) continue;
    const page = pages[f.page];
    if (!page) continue;
    const b = box(page, f);
    if (v.kind === "text") {
      const text = winAnsi(v.text).trim();
      if (!text) continue;
      const size = fitText(font, text, b.w, b.h);
      page.drawText(text, { x: b.x + 1, y: b.y + Math.max(1.5, (b.h - size) / 2 - 0.5), size, font, color: INK });
    } else if (v.kind === "check") {
      if (!v.on) continue;
      const size = Math.min(b.w, b.h) * 0.9;
      page.drawText("X", { x: b.x + (b.w - font.widthOfTextAtSize("X", size)) / 2, y: b.y + (b.h - size * 0.72) / 2, size, font, color: INK });
    } else {
      let img = imgCache.get(v.png);
      if (!img) {
        img = await doc.embedPng(v.png);
        imgCache.set(v.png, img);
      }
      const scale = Math.min(b.w / img.width, b.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: b.x + 1, y: b.y + (b.h - h) / 2, width: w, height: h });
    }
  }
  return doc.save({ useObjectStreams: false });
}

export type CertInfo = {
  envelopeId: string;
  documentName: string;
  firmName: string;
  originalSha256: string;
  clientSignedSha256: string;
  parties: { role: string; name: string; email: string; signedAt: string; ip?: string; method?: string }[];
  events: { at: string; text: string; actor: string; ip?: string | null }[];
  verifyUrl: string;
};

export async function appendCertificate(pdfBytes: Uint8Array, info: CertInfo): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = 612,
    H = 792,
    M = 54;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const line = (text: string, opts: { f?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    const size = opts.size ?? 9.5;
    const f = opts.f ?? font;
    const maxW = W - M - (opts.x ?? M);
    // wrap
    const words = winAnsi(text).split(" ");
    let cur = "";
    const flush = () => {
      if (y < M + 20) {
        page = doc.addPage([W, H]);
        y = H - M;
      }
      page.drawText(cur, { x: opts.x ?? M, y, size, font: f, color: opts.color ?? rgb(0.1, 0.1, 0.12) });
      y -= size + 4;
      cur = "";
    };
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) {
        flush();
        cur = w;
      } else cur = t;
    }
    if (cur) flush();
  };
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: rgb(0.12, 0.31, 0.82) });
  line("Certificate of Completion", { f: bold, size: 18 });
  y -= 4;
  line(`Envelope ID: ${info.envelopeId}`, { f: mono, size: 9 });
  line(`Document: ${info.documentName}`);
  line(`Sent by: ${info.firmName}`);
  y -= 8;
  line("Document integrity (SHA-256)", { f: bold, size: 11 });
  line(`Original agreement: ${info.originalSha256}`, { f: mono, size: 7.5 });
  line(`After client signature: ${info.clientSignedSha256}`, { f: mono, size: 7.5 });
  line(`The SHA-256 of this completed file is recorded by the platform. Check any copy at ${info.verifyUrl}`, { size: 8.5 });
  y -= 8;
  line("Signers", { f: bold, size: 11 });
  for (const p of info.parties) {
    line(`${p.role}: ${p.name} <${p.email}>`, { f: bold, size: 9.5 });
    line(`Signed ${p.signedAt}${p.ip ? `  |  IP ${p.ip}` : ""}${p.method ? `  |  ${p.method}` : ""}`, { x: M + 12, size: 8.5 });
  }
  y -= 8;
  line("Event history (UTC)", { f: bold, size: 11 });
  for (const e of info.events) {
    line(`${e.at.replace("T", " ").slice(0, 19)}   ${e.text}  (${e.actor}${e.ip ? `, IP ${e.ip}` : ""})`, { size: 8.5 });
  }
  y -= 10;
  line(
    "Electronic record and signature disclosure: each signer agreed to do business electronically and to use an electronic signature, which has the same legal effect as a handwritten signature under the U.S. ESIGN Act (15 U.S.C. 7001 et seq.) and the Uniform Electronic Transactions Act as adopted by the states.",
    { size: 8, color: rgb(0.35, 0.35, 0.4) },
  );
  return doc.save({ useObjectStreams: false });
}

// Fallback for agreements with no signature line: add a page the detector will recognise.
export async function appendSignaturePage(pdfBytes: Uint8Array, firmName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const first = doc.getPage(0);
  const { width: W, height: H } = first.getSize();
  const page = doc.addPage([W, H]);
  const M = 72;
  page.drawText("SIGNATURE PAGE", { x: M, y: H - M, size: 13, font: bold });
  page.drawText(winAnsi("By signing below, the parties agree to the terms of the agreement above."), { x: M, y: H - M - 22, size: 10, font });
  const block = (title: string, top: number) => {
    page.drawText(winAnsi(title), { x: M, y: top, size: 11, font: bold });
    const rows = ["Signature:", "Name:", "Title:", "Date:"];
    rows.forEach((r, i) => {
      const yy = top - 34 - i * 30;
      page.drawText(r, { x: M, y: yy, size: 10, font });
      page.drawText("_".repeat(40), { x: M + 70, y: yy, size: 10, font });
    });
  };
  block("CLIENT", H - M - 70);
  block(firmName.toUpperCase(), H - M - 260);
  return doc.save({ useObjectStreams: false });
}
