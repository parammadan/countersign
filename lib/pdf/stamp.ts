// Writes field values and signature images into the agreement, and builds the
// certificate of completion. Coordinates in `Field` are top-left origin points
// relative to the page's crop box (what pdf.js reports), so convert here.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from "pdf-lib";
import type { Field } from "../fields";
import { AppError } from "../errors";
import { printForPdf, showChars } from "./printable";

export type StampValue = { kind: "text"; text: string } | { kind: "image"; png: Uint8Array } | { kind: "check"; on: boolean };

const INK = rgb(0.05, 0.12, 0.35);

// pdf-lib standard fonts are WinAnsi only. Print what they can exactly (and the typographic equivalents in
// printable.ts); never alter anything else. Inputs refuse such text before it is saved (printProblem), so this
// only fires on older data: fail closed, before anything is signed or saved, instead of printing a different name.
// Who reads the refusal decides what it asks for: the client can only ask the sender, the firm can correct its
// data, and an upload is stopped before the agreement exists.
export type StampAudience = "firm" | "client" | "prepare";
const STAMP_REFUSAL: Record<StampAudience, (chars: string) => string> = {
  firm: (c) =>
    `This can't be signed: a name or value written onto the PDF has a character the PDF can't print exactly (${c}), and it is never printed altered. Nothing was signed or saved. It needs correcting to letters from Western European alphabets first.`,
  client: (c) =>
    `This document can't be signed yet: a name or value on it has a character the signed PDF can't print exactly (${c}). Nothing was signed. Ask the sender to correct it.`,
  prepare: (c) =>
    `This agreement can't be prepared for signing: your firm's legal name has a character the PDF can't print exactly (${c}). Nothing was saved. Correct it in Settings, with letters from Western European alphabets.`,
};

export class StampTextError extends AppError {
  constructor(
    public chars: string[],
    audience: StampAudience = "firm",
  ) {
    super(STAMP_REFUSAL[audience](showChars(chars)), 422);
  }
}

export function pdfText(s: string, audience: StampAudience = "firm"): string {
  const { text, bad } = printForPdf(s);
  if (bad.length) throw new StampTextError(bad, audience);
  return text;
}

// Field coordinates are pdf.js viewport coordinates: top-left origin, crop box applied, and the
// page's /Rotate applied. Invert that here (same matrices as pdf.js's PageViewport).
export function viewportMapper(page: PDFPage) {
  const cb = page.getCropBox();
  const rot = (((page.getRotation().angle ?? 0) % 360) + 360) % 360;
  const { x: x0, y: y0, width: W, height: H } = cb;
  const pt = (vx: number, vy: number): [number, number] => {
    switch (rot) {
      case 90:
        return [x0 + vy, y0 + vx];
      case 180:
        return [x0 + W - vx, y0 + vy];
      case 270:
        return [x0 + W - vy, y0 + H - vx];
      default:
        return [x0 + vx, y0 + H - vy];
    }
  };
  return { pt, rotate: degrees(rot) };
}

function fitText(font: PDFFont, text: string, w: number, h: number) {
  let size = Math.min(11, Math.max(6, h * 0.72));
  while (size > 5 && font.widthOfTextAtSize(text, size) > w - 2) size -= 0.5;
  return size;
}

export async function stampFields(pdfBytes: Uint8Array, fields: Field[], values: Map<string, StampValue>, audience: StampAudience = "firm"): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const imgCache = new Map<Uint8Array, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  for (const f of fields) {
    const v = values.get(f.id);
    if (!v) continue;
    const page = pages[f.page];
    if (!page) continue;
    const { pt, rotate } = viewportMapper(page);
    if (v.kind === "text") {
      const text = pdfText(v.text, audience).trim();
      if (!text) continue;
      const size = fitText(font, text, f.w, f.h);
      const [x, y] = pt(f.x + 1, f.y + f.h - Math.max(3, (f.h - size) / 2 + 1));
      page.drawText(text, { x, y, size, font, color: INK, rotate });
    } else if (v.kind === "check") {
      if (!v.on) continue;
      const size = Math.min(f.w, f.h) * 0.9;
      const [x, y] = pt(f.x + (f.w - font.widthOfTextAtSize("X", size)) / 2, f.y + f.h - (f.h - size * 0.72) / 2);
      page.drawText("X", { x, y, size, font, color: INK, rotate });
    } else {
      let img = imgCache.get(v.png);
      if (!img) {
        img = await doc.embedPng(v.png);
        imgCache.set(v.png, img);
      }
      const scale = Math.min(f.w / img.width, f.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const [x, y] = pt(f.x + 1, f.y + (f.h + h) / 2);
      page.drawImage(img, { x, y, width: w, height: h, rotate });
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

export async function appendCertificate(pdfBytes: Uint8Array, info: CertInfo, audience: StampAudience = "firm"): Promise<Uint8Array> {
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
    const words = pdfText(text, audience).split(" ");
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
  page.drawText("By signing below, the parties agree to the terms of the agreement above.", { x: M, y: H - M - 22, size: 10, font });
  const block = (title: string, top: number) => {
    page.drawText(pdfText(title, "prepare"), { x: M, y: top, size: 11, font: bold });
    const rows = ["Signature:", "Name:", "Title:", "Date:"];
    rows.forEach((r, i) => {
      const yy = top - 34 - i * 30;
      page.drawText(r, { x: M, y: yy, size: 10, font });
      page.drawText("_".repeat(40), { x: M + 70, y: yy, size: 10, font });
    });
  };
  block("CLIENT", H - M - 70);
  // upper case can leave WinAnsi (µ becomes Greek Μ); keep the name as written then
  const upper = firmName.toUpperCase();
  block(printForPdf(upper).bad.length ? firmName : upper, H - M - 260);
  return doc.save({ useObjectStreams: false });
}
