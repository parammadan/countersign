#!/usr/bin/env node
// Generates a corpus of FAKE client/engagement agreements for the field detector,
// plus ground truth (<name>.expected.json) for every PDF.
//
//   node scripts/make-fixtures.mjs
//
// All firm names, people, emails and addresses here are invented test data.
// Coordinates in expected.json: PDF points, top-left origin (same as lib/pdf/extract.ts).
// A field box is the area a person writes/signs in: its bottom sits on the blank line,
// signature boxes are 24pt tall, initials 18pt, checkboxes size+2, everything else 14pt.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, PageSizes, rgb } from "pdf-lib";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  TabStopType,
  Tab,
} from "docx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures", "agreements");
fs.mkdirSync(OUT, { recursive: true });

const LETTER = PageSizes.Letter; // [612, 792]
const A4 = PageSizes.A4; // [595.28, 841.89]
const BLACK = rgb(0, 0, 0);
const FIXED_DATE = new Date("2026-01-15T12:00:00Z");

const r1 = (v) => Math.round(v * 10) / 10;
function fieldH(type, size) {
  if (type === "signature") return 24;
  if (type === "initials") return 18;
  if (type === "checkbox") return size + 2;
  return 14;
}

// ---------------------------------------------------------------- layout writer
class Writer {
  constructor(pdf, fonts, o = {}) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.size = o.pageSize ?? LETTER;
    const fam = o.font ?? "Helvetica";
    this.font = fonts[fam];
    this.bold = fonts[fam + "Bold"];
    this.fs = o.fontSize ?? 10;
    this.lead = o.leading ?? 1.4;
    this.m = o.margin ?? 72;
    this.bottomM = o.bottom ?? this.m;
    this.footer = o.footer;
    this.fields = [];
    this.pages = [];
    this.newPage();
  }
  get W() {
    return this.size[0];
  }
  get H() {
    return this.size[1];
  }
  get pi() {
    return this.pages.indexOf(this.page);
  }
  get textW() {
    return this.W - 2 * this.m;
  }
  newPage() {
    this.page = this.pdf.addPage(this.size);
    this.pages.push(this.page);
    this.y = this.m;
    return this.page;
  }
  ensure(h) {
    if (this.y + h > this.H - this.bottomM) this.newPage();
  }
  advance(n) {
    this.y += n;
  }
  wid(s, o = {}) {
    return (o.font ?? this.font).widthOfTextAtSize(s, o.size ?? this.fs);
  }
  // absolute text at a baseline (top-left coordinates); returns end x
  text(s, x, base, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    this.page.drawText(s, { x, y: this.H - base, size, font, color: BLACK });
    return x + font.widthOfTextAtSize(s, size);
  }
  expect(f) {
    const e = { page: f.page ?? this.pi, type: f.type, role: f.role, x: r1(f.x), y: r1(f.y), w: r1(f.w), h: r1(f.h) };
    if (f.note) e.note = f.note;
    if (f.acceptRoles) e.acceptRoles = f.acceptRoles;
    if (f.acceptTypes) e.acceptTypes = f.acceptTypes;
    this.fields.push(e);
  }
  // a run of underscores of ~w points starting at x; records the field if given
  blank(x, base, w, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const uw = font.widthOfTextAtSize("_", size);
    const n = Math.max(3, Math.round(w / uw));
    this.text("_".repeat(n), x, base, o);
    const ww = n * uw;
    if (field) {
      const h = fieldH(field.type, size);
      this.expect({ ...field, x, y: base + 2 - h, w: ww, h });
    }
    return x + ww;
  }
  // "Label: ______" drawn as ONE text item, total width ~totalW
  labeled(label, x, base, totalW, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const lw = font.widthOfTextAtSize(label + " ", size);
    const uw = font.widthOfTextAtSize("_", size);
    const n = Math.max(3, Math.round((totalW - lw) / uw));
    this.text(label + " " + "_".repeat(n), x, base, o);
    if (field) {
      const h = fieldH(field.type, size);
      this.expect({ ...field, x: x + lw, y: base + 2 - h, w: n * uw, h });
    }
    return x + lw + n * uw;
  }
  // "Label ....................." dot leaders
  dotted(label, x, base, totalW, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const lw = font.widthOfTextAtSize(label + " ", size);
    const dw = font.widthOfTextAtSize(".", size);
    const n = Math.max(8, Math.round((totalW - lw) / dw));
    this.text(label + " " + ".".repeat(n), x, base, o);
    if (field) {
      const h = fieldH(field.type, size);
      this.expect({ ...field, x: x + lw, y: base + 2 - h, w: n * dw, h });
    }
    return x + lw + n * dw;
  }
  // vector line 2pt below the baseline; the field sits on it
  hline(x0, x1, base, field, o = {}) {
    const ly = base + 2;
    this.page.drawLine({ start: { x: x0, y: this.H - ly }, end: { x: x1, y: this.H - ly }, thickness: o.thickness ?? 0.75, color: BLACK });
    if (field) {
      const h = fieldH(field.type, o.size ?? this.fs);
      this.expect({ ...field, x: x0, y: ly - h, w: x1 - x0, h });
    }
    return ly;
  }
  checkbox(x, base, label, field, o = {}) {
    const size = o.size ?? this.fs;
    this.text("[ ]  " + label, x, base, o);
    if (field) this.expect({ ...field, type: "checkbox", x: x - 1, y: base - size * 0.8 - 1, w: size + 2, h: size + 2 });
  }
  // wrapped paragraph; o.lead = bold run-in heading ("3. Fees.")
  para(body, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const bold = this.bold;
    const indent = o.indent ?? 0;
    const maxW = this.textW - indent - (o.rightIndent ?? 0);
    const toks = [];
    if (o.lead) for (const t of o.lead.split(" ")) toks.push({ t, f: bold });
    for (const t of body.split(/\s+/).filter(Boolean)) toks.push({ t, f: font });
    const sp = font.widthOfTextAtSize(" ", size);
    const lines = [];
    let cur = [];
    let cw = 0;
    for (const tok of toks) {
      const tw = tok.f.widthOfTextAtSize(tok.t, size);
      if (cur.length && cw + sp + tw > maxW) {
        lines.push(cur);
        cur = [];
        cw = 0;
      }
      cw += (cur.length ? sp : 0) + tw;
      cur.push(tok);
    }
    if (cur.length) lines.push(cur);
    const lh = size * this.lead;
    for (const ln of lines) {
      this.ensure(lh);
      const base = this.y + size;
      // group same-font tokens into one text run
      const lineW = ln.reduce((a, k, i) => a + k.f.widthOfTextAtSize(k.t, size) + (i ? sp : 0), 0);
      let x = this.m + indent;
      if (o.align === "center") x = (this.W - lineW) / 2;
      let i = 0;
      while (i < ln.length) {
        let j = i;
        while (j < ln.length && ln[j].f === ln[i].f) j++;
        const s = ln
          .slice(i, j)
          .map((k) => k.t)
          .join(" ");
        x = this.text(s, x, base, { size, font: ln[i].f }) + sp;
        i = j;
      }
      this.y += lh;
    }
    this.y += o.after ?? size * 0.55;
  }
  title(s, size = 14, after = 10) {
    this.ensure(size * 2);
    const w = this.bold.widthOfTextAtSize(s, size);
    this.text(s, (this.W - w) / 2, this.y + size, { size, font: this.bold });
    this.y += size * 1.4 + after;
  }
  heading(s, o = {}) {
    const size = o.size ?? this.fs + 1;
    this.ensure(size * 3);
    this.y += o.before ?? 4;
    this.text(s, this.m, this.y + size, { size, font: this.bold });
    this.y += size * 1.5;
  }
  // a single line made of parts: strings and { blank: width, field }
  inline(parts, o = {}) {
    const size = o.size ?? this.fs;
    this.ensure(size * this.lead);
    const base = this.y + size;
    let x = o.x ?? this.m;
    for (const p of parts) {
      if (typeof p === "string") x = this.text(p, x, base, o);
      else x = this.blank(x, base, p.blank, p.field, o);
    }
    this.y += size * this.lead;
    return base;
  }
  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      this.footer?.(this, i, n);
    });
  }
}

// two signature columns side by side; each row is "Label: ____" in one text item
function sigColumns(w, cols, rows, o = {}) {
  const gap = o.gap ?? 36;
  const colW = (w.textW - gap) / 2;
  const rowH = o.rowH ?? 30;
  w.ensure(rowH * (rows.length + 1) + 30);
  // headings may span several lines ("SIGNED for and on behalf of\nTHORNBURY DIGITAL LTD")
  const nHead = Math.max(...cols.map((c) => c.heading.split("\n").length));
  cols.forEach((c, i) =>
    c.heading.split("\n").forEach((t, k) => {
      const x = w.m + i * (colW + gap);
      if (w.wid(t, { font: w.bold }) > colW) throw new Error(`column heading wider than column: ${t}`);
      w.text(t, x, w.y + w.fs + k * w.fs * 1.3, { font: w.bold });
    }),
  );
  const hb = w.y + w.fs + (nHead - 1) * w.fs * 1.3;
  rows.forEach((r, ri) => {
    const base = hb + rowH * (ri + 1) + (ri === 0 ? 6 : 0);
    cols.forEach((c, i) => {
      const x = w.m + i * (colW + gap);
      const fn = o.dots ? "dotted" : "labeled";
      w[fn](r.label, x, base, colW, { type: r.type, role: c.role, note: `${c.heading.replace("\n", " ")} / ${r.label}`, ...(r.extra ?? {}) });
    });
  });
  w.y = hb + rowH * rows.length + 30;
}

// one stacked block. style: underscore (label+underscores in one item), aligned (label, gap, underscores),
// drawn (label + vector line to the right)
function sigStack(w, heading, rows, role, o = {}) {
  const style = o.style ?? "underscore";
  const x = o.x ?? w.m;
  const labelW = o.labelW ?? 90;
  const lineW = o.lineW ?? 230;
  const rowH = o.rowH ?? 28;
  w.ensure(rowH * (rows.length + 1) + 20);
  let base = w.y + w.fs;
  if (heading) {
    w.text(heading, x, base, { font: w.bold });
    base += 8;
  }
  for (const [ri, r] of rows.entries()) {
    base += rowH + (ri === 0 ? 4 : 0);
    const f = { type: r.type, role, note: `${heading ?? ""} / ${r.label}`.trim(), ...(r.extra ?? {}) };
    if (style === "underscore") w.labeled(r.label, x, base, labelW + lineW, f);
    else if (style === "aligned") {
      w.text(r.label, x, base);
      w.blank(x + labelW, base, lineW, f);
    } else {
      w.text(r.label, x, base);
      w.hline(x + labelW, x + labelW + lineW, base, f);
    }
  }
  w.y = base + 24;
}

// ---------------------------------------------------------------- boilerplate
function clauses(F, C) {
  const P = `${F} and ${C}`;
  return {
    services: [
      "Services.",
      `${F} will provide the services described in each statement of work signed by the parties (each, an "SOW"). Each SOW is incorporated into this Agreement by reference. If this Agreement conflicts with an SOW, this Agreement controls unless the SOW expressly identifies the provision of this Agreement it modifies. ${F} may use employees and approved subcontractors to perform the Services and remains responsible for their work.`,
    ],
    resp: [
      "Client Responsibilities.",
      `${C} will provide timely access to the information, personnel, systems and premises reasonably required for ${F} to perform the Services, and is responsible for the accuracy and completeness of all information it provides. Delays caused by ${C}'s failure to meet these responsibilities may extend the schedule and may result in additional fees at ${F}'s then-current rates.`,
    ],
    fees: [
      "Fees and Payment.",
      `${C} will pay the fees set out in the applicable SOW. Unless an SOW states otherwise, ${F} will invoice monthly in arrears and each invoice is due within thirty (30) days of its date. Late amounts accrue interest at the lesser of one percent (1%) per month or the highest rate permitted by law. ${F} may suspend the Services on ten (10) days' written notice if an undisputed invoice remains unpaid more than thirty (30) days after its due date.`,
    ],
    expenses: [
      "Expenses.",
      `${C} will reimburse reasonable, pre-approved travel and out-of-pocket expenses incurred in performing the Services. Expenses are billed at cost, without markup, and are supported by receipts on request.`,
    ],
    taxes: [
      "Taxes.",
      `Fees do not include sales, use, value-added, goods and services or similar taxes. ${C} is responsible for all such taxes other than taxes based on ${F}'s net income, property or employees.`,
    ],
    term: [
      "Term and Termination.",
      `This Agreement begins on the Effective Date and continues until terminated as provided here. Either party may terminate this Agreement or any SOW for convenience on thirty (30) days' written notice. Either party may terminate immediately on written notice if the other party materially breaches this Agreement and does not cure the breach within fifteen (15) days after receiving notice describing it. On termination, ${C} will pay for all Services performed and expenses incurred through the effective date of termination.`,
    ],
    conf: [
      "Confidentiality.",
      `Each party may receive non-public information of the other party that is marked confidential or that a reasonable person would understand to be confidential ("Confidential Information"). The receiving party will use Confidential Information only to perform or receive the Services, will protect it with at least reasonable care, and will disclose it only to its personnel and advisors who need to know it and are bound by duties of confidentiality at least as protective as these. These obligations do not apply to information that is or becomes public through no fault of the receiving party, was known to it before disclosure, is independently developed, or is rightfully received from a third party without restriction. A party may disclose Confidential Information when required by law, after giving the other party prompt notice where legally permitted.`,
    ],
    ip: [
      "Intellectual Property.",
      `Upon full payment, ${C} owns the final deliverables identified in an SOW as created specifically for ${C} (the "Deliverables"). ${F} retains all rights in its pre-existing materials, tools, templates, know-how and general skills ("${F} Materials"). To the extent any ${F} Materials are incorporated into a Deliverable, ${F} grants ${C} a non-exclusive, perpetual, royalty-free license to use them as part of that Deliverable for ${C}'s internal business purposes.`,
    ],
    warranty: [
      "Warranties.",
      `${F} warrants that the Services will be performed in a professional and workmanlike manner consistent with generally accepted industry standards. ${C}'s exclusive remedy for breach of this warranty is re-performance of the non-conforming Services, provided ${C} notifies ${F} in writing within thirty (30) days after the Services were performed.`,
    ],
    disclaimer: [
      "Disclaimer.",
      `EXCEPT AS EXPRESSLY STATED IN THIS AGREEMENT, NEITHER PARTY MAKES ANY WARRANTY, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE OR NON-INFRINGEMENT. ${F.toUpperCase()} DOES NOT WARRANT THAT ANY RESULT OR OUTCOME WILL BE ACHIEVED.`,
    ],
    liability: [
      "Limitation of Liability.",
      `IN NO EVENT WILL EITHER PARTY BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS OR REVENUE, EVEN IF ADVISED OF THEIR POSSIBILITY. EACH PARTY'S TOTAL LIABILITY ARISING OUT OF THIS AGREEMENT WILL NOT EXCEED THE FEES PAID OR PAYABLE UNDER THIS AGREEMENT IN THE TWELVE (12) MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM. THESE LIMITS DO NOT APPLY TO A PARTY'S INDEMNIFICATION OBLIGATIONS OR TO ${C.toUpperCase()}'S OBLIGATION TO PAY FEES.`,
    ],
    indemnity: [
      "Indemnification.",
      `Each party will defend and indemnify the other party and its officers, employees and agents against third-party claims, and the resulting losses, damages and reasonable attorneys' fees, to the extent arising from the indemnifying party's gross negligence, willful misconduct or violation of law. The indemnified party will give prompt notice of the claim, reasonable cooperation, and sole control of the defense to the indemnifying party.`,
    ],
    insurance: [
      "Insurance.",
      `During the term ${F} will maintain commercial general liability insurance and professional liability insurance with limits not less than one million dollars ($1,000,000) per claim, and will provide certificates of insurance on request.`,
    ],
    nonsolicit: [
      "Non-Solicitation.",
      `During the term and for twelve (12) months afterward, neither party will knowingly solicit for employment any employee of the other party who was directly involved in the Services. General advertisements not targeted at the other party's personnel do not violate this Section.`,
    ],
    contractor: [
      "Independent Contractor.",
      `${F} is an independent contractor. Nothing in this Agreement creates a partnership, joint venture, agency or employment relationship between ${P}. Neither party has authority to bind the other.`,
    ],
    data: [
      "Data Protection.",
      `If ${F} processes personal information on behalf of ${C}, ${F} will process it only on ${C}'s documented instructions, will implement appropriate technical and organizational security measures, and will notify ${C} without undue delay after becoming aware of a security incident affecting that information. At the end of the Services, ${F} will return or delete such personal information unless retention is required by law.`,
    ],
    law: [
      "Governing Law.",
      `This Agreement is governed by the laws of the State of Delaware, without regard to its conflict of laws rules. The parties submit to the exclusive jurisdiction of the state and federal courts located in Wilmington, Delaware for any dispute arising out of this Agreement.`,
    ],
    notices: [
      "Notices.",
      `Notices under this Agreement must be in writing and are effective when delivered by hand, by nationally recognized courier, or by email with confirmation of transmission, to the addresses each party designates in writing. Notices to ${F} must be sent to the attention of its legal department.`,
    ],
    misc: [
      "Miscellaneous.",
      `This Agreement, together with each SOW, is the entire agreement between ${P} regarding its subject matter and supersedes all prior proposals and understandings. Any amendment must be in writing and signed by both parties. If any provision is held unenforceable, the remaining provisions remain in effect. Neither party may assign this Agreement without the other party's consent, except to a successor in a merger or sale of substantially all of its assets. This Agreement may be executed in counterparts and by electronic signature, each of which is deemed an original.`,
    ],
  };
}
function writeClauses(w, F, C, keys, o = {}) {
  const c = clauses(F, C);
  keys.forEach((k, i) => {
    const [h, b] = c[k];
    w.para(b, { lead: `${(o.start ?? 1) + i}. ${h}`, ...o.para });
  });
}

// ---------------------------------------------------------------- tiny PNG raster (for "scanned" pages)
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, px) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
class Raster {
  constructor(wPt, hPt, seed = 1, S = 1.5) {
    this.S = S;
    this.wPt = wPt;
    this.hPt = hPt;
    this.w = Math.round(wPt * S);
    this.h = Math.round(hPt * S);
    this.px = new Uint8Array(this.w * this.h).fill(244);
    this.rnd = mulberry32(seed);
    for (let i = 0; i < this.px.length / 500; i++) this.px[Math.floor(this.rnd() * this.px.length)] = 170 + Math.floor(this.rnd() * 60);
  }
  rect(x, y, w, h, v = 40) {
    const S = this.S;
    const x0 = Math.max(0, Math.round(x * S));
    const y0 = Math.max(0, Math.round(y * S));
    const x1 = Math.min(this.w, Math.round((x + w) * S));
    const y1 = Math.min(this.h, Math.round((y + h) * S));
    for (let yy = y0; yy < y1; yy++) this.px.fill(v, yy * this.w + x0, yy * this.w + x1);
  }
  // fake words: dark bars at x-height with occasional ascenders
  words(x0, x1, base, size) {
    let x = x0;
    while (x < x1 - 8) {
      const ww = Math.min(x1 - x, size * (0.9 + this.rnd() * 4.5));
      this.rect(x, base - size * 0.5, ww, size * 0.5);
      if (this.rnd() < 0.6) this.rect(x + this.rnd() * ww * 0.7, base - size * 0.72, size * 0.12, size * 0.25);
      x += ww + size * 0.33;
    }
  }
  para(x0, x1, base, size, n, lead = 1.45) {
    for (let i = 0; i < n; i++) this.words(x0, i === n - 1 ? x0 + (x1 - x0) * (0.3 + this.rnd() * 0.5) : x1, base + i * size * lead, size);
    return base + n * size * lead;
  }
  line(x0, x1, y) {
    this.rect(x0, y - 0.5, x1 - x0, 1.1, 30);
  }
  png() {
    return encodePng(this.w, this.h, this.px);
  }
}
async function drawRaster(pdf, page, r) {
  const img = await pdf.embedPng(r.png());
  page.drawImage(img, { x: 0, y: 0, width: r.wPt, height: r.hPt });
}

// ---------------------------------------------------------------- output
const written = [];
async function pdfFixture(name, meta, opts, draw) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title ?? name);
  pdf.setAuthor("Countersign test corpus (fake data)");
  pdf.setProducer("countersign make-fixtures");
  pdf.setCreator("countersign make-fixtures");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const fonts = {
    Helvetica: await pdf.embedFont(StandardFonts.Helvetica),
    HelveticaBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    TimesRoman: await pdf.embedFont(StandardFonts.TimesRoman),
    TimesRomanBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
  };
  const w = new Writer(pdf, fonts, opts);
  await draw(w, pdf);
  w.finish();
  if (meta.pages && w.pages.length !== meta.pages) throw new Error(`${name}: expected ${meta.pages} pages, got ${w.pages.length}`);
  if (meta.pageRange && (w.pages.length < meta.pageRange[0] || w.pages.length > meta.pageRange[1]))
    throw new Error(`${name}: expected ${meta.pageRange.join("-")} pages, got ${w.pages.length}`);
  const bytes = await pdf.save({ useObjectStreams: false });
  fs.writeFileSync(path.join(OUT, name + ".pdf"), bytes);
  const fields = w.fields.slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const expected = {
    firmName: meta.firmName,
    description: meta.description,
    pages: w.pages.length,
    pageSize: [r1(w.W), r1(w.H)],
    fields,
    warnings: meta.warnings ?? [],
    ...(meta.note ? { note: meta.note } : {}),
  };
  fs.writeFileSync(path.join(OUT, name + ".expected.json"), JSON.stringify(expected, null, 2) + "\n");
  written.push(`${name}.pdf  (${w.pages.length}p, ${fields.length} fields)`);
}

const pageNum = (label) => (w, i, n) => {
  const s = `${label}Page ${i + 1} of ${n}`;
  w.text(s, (w.W - w.wid(s, { size: 8 })) / 2, w.H - 36, { size: 8 });
};

// ================================================================= PDF fixtures

// 01: the easy case
await pdfFixture(
  "01-simple-one-page",
  {
    firmName: "Maple Ridge Bookkeeping LLC",
    description: "1 page, Helvetica 11, Letter. One line 'Client Signature: ____   Date: ____' (two separate text items). No firm signature line.",
    warnings: ["No signature line for your firm"],
    pages: 1,
  },
  { font: "Helvetica", fontSize: 11, pageSize: LETTER },
  (w) => {
    w.title("CLIENT SERVICES AGREEMENT", 14);
    w.para(
      `This Client Services Agreement (the "Agreement") is between Maple Ridge Bookkeeping LLC ("Maple Ridge") and the client signing below ("Client"). Maple Ridge will provide monthly bookkeeping and payroll reconciliation services for Client on the terms below.`,
    );
    writeClauses(w, "Maple Ridge", "Client", ["fees", "resp", "term", "conf", "law"]);
    w.advance(30);
    const base = w.y + 11;
    w.text("Client Signature:", w.m, base);
    w.blank(w.m + w.wid("Client Signature: "), base, 190, { type: "signature", role: "client", note: "Client Signature" });
    w.text("Date:", w.m + 320, base);
    w.blank(w.m + 320 + w.wid("Date: "), base, 110, { type: "date", role: "client", note: "Date" });
  },
);

// 02: classic MSA, two-column block under IN WITNESS WHEREOF
await pdfFixture(
  "02-msa-two-column",
  {
    firmName: "Northwind Advisory, LLC",
    description:
      "5-page MSA, TimesRoman 11, Letter. Last page: IN WITNESS WHEREOF + two columns side by side; left heading = firm legal name 'NORTHWIND ADVISORY, LLC', right heading 'CLIENT'; By:/Name:/Title:/Date: as 'Label: ____' single text items.",
    pageRange: [4, 6],
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER, margin: 78, leading: 1.45, footer: pageNum("Northwind Advisory MSA v3.2  |  ") },
  (w) => {
    w.title("MASTER SERVICES AGREEMENT", 15, 12);
    w.para(
      `This Master Services Agreement (the "Agreement") is entered into as of the date of the last signature below (the "Effective Date") by and between Northwind Advisory, LLC, a Delaware limited liability company ("Northwind"), and the client identified in the signature block below ("Client"). Northwind and Client are each a "Party" and together the "Parties".`,
    );
    w.heading("1. Definitions");
    const defs = [
      `(a) "Affiliate" means any entity that directly or indirectly controls, is controlled by, or is under common control with a Party, where "control" means ownership of more than fifty percent (50%) of the voting interests of the entity.`,
      `(b) "Change Order" means a written document signed by both Parties that modifies the scope, schedule or fees of an SOW.`,
      `(c) "Personnel" means a Party's employees, contractors and subcontractors who perform obligations under this Agreement.`,
      `(d) "Services" means the advisory, analytical and implementation services described in an SOW, and any related Deliverables.`,
      `(e) "Business Day" means any day other than a Saturday, Sunday or a day on which banks in New York, New York are authorized to close.`,
    ];
    for (const d of defs) w.para(d, { indent: 18 });
    writeClauses(
      w,
      "Northwind",
      "Client",
      ["services", "resp", "fees", "expenses", "taxes", "term", "conf", "ip", "warranty", "disclaimer", "liability", "indemnity", "insurance", "nonsolicit", "contractor", "data", "notices", "law", "misc"],
      { start: 2 },
    );
    w.advance(8);
    w.para("IN WITNESS WHEREOF, the Parties have caused this Agreement to be executed by their duly authorized representatives as of the Effective Date.");
    w.advance(10);
    sigColumns(
      w,
      [
        { heading: "NORTHWIND ADVISORY, LLC", role: "firm" },
        { heading: "CLIENT", role: "client" },
      ],
      [
        { label: "By:", type: "signature" },
        { label: "Name:", type: "name" },
        { label: "Title:", type: "title" },
        { label: "Date:", type: "date" },
      ],
    );
  },
);

// 03: stacked PROVIDER above CUSTOMER, vector lines right of the label
await pdfFixture(
  "03-stacked-provider-customer",
  {
    firmName: "Lumen Data Services Ltd",
    description:
      "3-page A4, Helvetica 10. Stacked blocks: 'PROVIDER' block above 'CUSTOMER' block. Labels 'Signature:' 'Name:' 'Title:' 'Date:' followed by drawn vector lines (no underscores).",
    pageRange: [2, 4],
  },
  { font: "Helvetica", fontSize: 10, pageSize: A4, margin: 64, footer: pageNum("") },
  (w) => {
    w.title("DATA SERVICES AGREEMENT", 14);
    w.para(
      `This Data Services Agreement is made between Lumen Data Services Ltd, a company registered in England and Wales ("Provider"), and the customer whose details appear in the signature block ("Customer"). Provider will supply data cleansing, enrichment and reporting services to Customer as described in the order form.`,
    );
    writeClauses(w, "Provider", "Customer", ["services", "resp", "fees", "taxes", "term", "conf", "data", "warranty", "liability", "contractor", "law", "misc"]);
    w.advance(6);
    w.para("Signed by the authorised representatives of the parties:");
    w.advance(4);
    const rows = [
      { label: "Signature:", type: "signature" },
      { label: "Name:", type: "name" },
      { label: "Title:", type: "title" },
      { label: "Date:", type: "date" },
    ];
    w.ensure(2 * 150);
    sigStack(w, "PROVIDER", rows, "firm", { style: "drawn", labelW: 70, lineW: 240 });
    sigStack(w, "CUSTOMER", rows, "client", { style: "drawn", labelW: 70, lineW: 240 });
  },
);

// 04: defined terms ("Brightline" or the "Company") and signature headings by defined term
await pdfFixture(
  "04-defined-terms-company-client",
  {
    firmName: "Brightline Consulting Group, Inc.",
    description:
      "3-page Letter, TimesRoman 10.5, curly quotes. Preamble: Brightline Consulting Group, Inc. (“Brightline” or the “Company”) and the client named below (“Client”). Side-by-side headings 'COMPANY' / 'CLIENT' using defined terms; rows Signature:/Printed Name:/Title:/Date:.",
    pageRange: [2, 4],
  },
  { font: "TimesRoman", fontSize: 10.5, pageSize: LETTER, margin: 72, footer: pageNum("") },
  (w) => {
    w.title("CONSULTING ENGAGEMENT AGREEMENT", 14);
    w.para(
      `This Consulting Engagement Agreement (this “Agreement”) is made by and between Brightline Consulting Group, Inc., a Colorado corporation (“Brightline” or the “Company”), and the client named below (“Client”). The Company and Client agree as follows.`,
    );
    writeClauses(w, "the Company", "Client", ["services", "resp", "fees", "expenses", "term", "conf", "ip", "warranty", "disclaimer", "liability", "nonsolicit", "contractor", "law", "misc"]);
    w.advance(14);
    sigColumns(
      w,
      [
        { heading: "COMPANY", role: "firm" },
        { heading: "CLIENT", role: "client" },
      ],
      [
        { label: "Signature:", type: "signature" },
        { label: "Printed Name:", type: "name" },
        { label: "Title:", type: "title" },
        { label: "Date:", type: "date" },
      ],
      { rowH: 32 },
    );
  },
);

// 05: vector lines with the label printed UNDER the line, no underscores, no colons
await pdfFixture(
  "05-drawn-lines-label-under",
  {
    firmName: "Harborview Tax Partners LLP",
    description:
      "2-page Letter, Helvetica 10. Signature lines are vector lines with captions printed under them ('Signature', 'Printed Name', 'Date'), no underscores. Party headings 'CLIENT' and 'HARBORVIEW TAX PARTNERS LLP' above each group.",
    pageRange: [1, 3],
  },
  { font: "Helvetica", fontSize: 10, pageSize: LETTER },
  (w) => {
    w.title("TAX ENGAGEMENT LETTER", 14);
    w.para(
      `This letter confirms the terms on which Harborview Tax Partners LLP ("Harborview") will prepare federal and state income tax returns for you ("Client") for the 2026 tax year. Please read it carefully, sign where indicated, and return it to us.`,
    );
    writeClauses(w, "Harborview", "Client", ["services", "resp", "fees", "term", "conf", "liability", "misc"]);
    w.advance(10);
    const group = (heading, role) => {
      w.ensure(120);
      w.text(heading, w.m, w.y + 10, { font: w.bold });
      let base = w.y + 10 + 40;
      w.hline(w.m, w.m + 250, base, { type: "signature", role, note: `${heading} / Signature` });
      w.hline(w.m + 300, w.m + 450, base, { type: "date", role, note: `${heading} / Date` });
      w.text("Signature", w.m, base + 13, { size: 8.5 });
      w.text("Date", w.m + 300, base + 13, { size: 8.5 });
      base += 42;
      w.hline(w.m, w.m + 250, base, { type: "name", role, note: `${heading} / Printed Name` });
      w.text("Printed Name", w.m, base + 13, { size: 8.5 });
      w.y = base + 36;
    };
    group("CLIENT", "client");
    group("HARBORVIEW TAX PARTNERS LLP", "firm");
  },
);

// 06: body blanks that are filled from file data (prefill)
await pdfFixture(
  "06-body-blanks",
  {
    firmName: "Cedar & Finch Legal Services, PLLC",
    description:
      "2-page Letter, TimesRoman 11. Body blanks inside running text ('made on ____ between ... and ____ (\"Client\")') and a matter box: Client Name / Client Email / Matter Reference / Effective Date / Fee: $____ / Retainer: $____. Then client + firm signature lines.",
    pageRange: [1, 3],
    note: "Body blanks are role=prefill (filled from file data before sending). The blank before (\"Client\") is the client's name.",
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER },
  (w) => {
    w.title("ENGAGEMENT AGREEMENT FOR LEGAL SERVICES", 13);
    w.inline([
      "This Engagement Agreement is made on ",
      { blank: 110, field: { type: "date", role: "prefill", note: "made on ____" } },
      " between Cedar & Finch Legal Services,",
    ]);
    w.inline([
      'PLLC ("Firm") and ',
      { blank: 170, field: { type: "name", role: "prefill", acceptTypes: ["company"], note: 'and ____ ("Client")' } },
      ' ("Client"), for the matter described below.',
    ]);
    w.advance(8);
    w.heading("Matter Details");
    const row = (label, type, extra = {}) => {
      const base = w.y + 11;
      w.text(label, w.m + 12, base);
      w.blank(w.m + 140, base, 220, { type, role: "prefill", note: label, ...extra });
      w.y += 22;
    };
    row("Client Name:", "name");
    row("Client Email:", "email");
    row("Matter Reference:", "text");
    row("Effective Date:", "date");
    {
      const base = w.y + 11;
      w.text("Hourly Fee:", w.m + 12, base);
      w.text("$", w.m + 140, base);
      w.blank(w.m + 140 + w.wid("$"), base, 90, { type: "text", role: "prefill", note: "Fee: $____" });
      w.text("per hour", w.m + 140 + w.wid("$") + 96, base);
      w.y += 22;
    }
    w.inline(["Retainer Deposit: $", { blank: 90, field: { type: "text", role: "prefill", note: "Retainer: $____" } }, ", payable on signing."], { x: w.m + 12 });
    w.advance(8);
    writeClauses(w, "the Firm", "Client", ["services", "resp", "fees", "term", "conf", "misc"]);
    w.advance(20);
    w.ensure(120);
    let base = w.y + 11;
    w.labeled("Client Signature:", w.m, base, 280, { type: "signature", role: "client", note: "Client Signature" });
    w.labeled("Date:", w.m + 310, base, 158, { type: "date", role: "client", note: "client Date" });
    base += 40;
    w.text("CEDAR & FINCH LEGAL SERVICES, PLLC", w.m, base, { font: w.bold });
    base += 32;
    w.labeled("By:", w.m, base, 280, { type: "signature", role: "firm", note: "firm By" });
    w.labeled("Date:", w.m + 310, base, 158, { type: "date", role: "firm", note: "firm Date" });
    w.y = base + 20;
  },
);

// 07: initials footer on every page
await pdfFixture(
  "07-initials-footer",
  {
    firmName: "Oakline Staffing Solutions, Inc.",
    description:
      "3-page A4, Helvetica 9.5. Footer on every page: left 'OSS-CSA-2026 | Page n of N', right 'Client Initials: ______'. Stacked underscore blocks on last page: firm (OAKLINE STAFFING SOLUTIONS, INC.) then CLIENT; first row 'Authorized Signature:'.",
    pageRange: [3, 5],
  },
  {
    font: "Helvetica",
    fontSize: 9.5,
    pageSize: A4,
    margin: 60,
    bottom: 80,
    footer: (w, i, n) => {
      const base = w.H - 40;
      w.text(`OSS-CSA-2026  |  Page ${i + 1} of ${n}`, w.m, base, { size: 8 });
      const lx = w.W - w.m - 150;
      w.text("Client Initials:", lx, base, { size: 9 });
      w.blank(lx + w.wid("Client Initials: ", { size: 9 }), base, 150 - w.wid("Client Initials: ", { size: 9 }), { type: "initials", role: "client", note: `initials p${i + 1}` }, { size: 9 });
    },
  },
  (w) => {
    w.title("CONTINGENT STAFFING AGREEMENT", 13);
    w.para(
      `This Contingent Staffing Agreement is entered into between Oakline Staffing Solutions, Inc. ("Oakline") and the client company signing below ("Client"). Oakline will assign temporary workers ("Assigned Workers") to Client on the terms of this Agreement and each work order.`,
    );
    const extra = [
      `Assigned Workers remain employees of Oakline. Oakline is responsible for their wages, payroll taxes, workers' compensation coverage and benefits. Client will supervise the day-to-day work of Assigned Workers, will provide a safe workplace that complies with applicable occupational safety laws, and will not assign them duties outside the job description in the work order without Oakline's prior written consent.`,
      `Client will verify and approve Assigned Worker time records weekly. Approved time records are final for billing purposes. Overtime is billed at one and one-half (1.5) times the regular bill rate when required by law.`,
      `If Client hires an Assigned Worker directly, or through another agency, within ninety (90) days after the worker's last day on assignment, Client will pay Oakline a conversion fee equal to twenty percent (20%) of the worker's first-year base salary.`,
    ];
    writeClauses(w, "Oakline", "Client", ["services", "resp", "fees", "taxes", "term", "conf", "insurance", "indemnity"]);
    extra.forEach((t, i) => w.para(t, { lead: `${9 + i}. ${["Employment Status.", "Time Records.", "Conversion Fee."][i]}` }));
    writeClauses(w, "Oakline", "Client", ["warranty", "disclaimer", "liability", "nonsolicit", "contractor", "data", "notices", "law", "misc"], { start: 12 });
    w.advance(10);
    w.para("Agreed and accepted by the authorized representatives of the parties:");
    const rows = [
      { label: "Authorized Signature:", type: "signature" },
      { label: "Name:", type: "name" },
      { label: "Title:", type: "title" },
      { label: "Date:", type: "date" },
    ];
    sigStack(w, "OAKLINE STAFFING SOLUTIONS, INC.", rows, "firm", { style: "aligned", labelW: 105, lineW: 210, rowH: 26 });
    sigStack(w, "CLIENT", rows, "client", { style: "aligned", labelW: 105, lineW: 210, rowH: 26 });
  },
);

// 08: consent checkboxes "[ ]" + industry party term ("Policyholder")
await pdfFixture(
  "08-checkboxes-consents",
  {
    firmName: "Pinecrest Insurance Agency, LLC",
    description:
      "2-page Letter, Helvetica 10. Party = 'Policyholder' (defined as 'the undersigned policyholder'). Three '[ ]' consent checkboxes, then 'Policyholder Signature: ____  Date: ____', 'Printed Name: ____'; firm block under 'FOR THE AGENCY' with 'Licensed Agent Signature: ____'.",
    pageRange: [1, 3],
  },
  { font: "Helvetica", fontSize: 10, pageSize: LETTER, footer: pageNum("") },
  (w) => {
    w.title("BROKER SERVICE AGREEMENT", 14);
    w.para(
      `This Broker Service Agreement is between Pinecrest Insurance Agency, LLC ("Agency") and the undersigned policyholder ("Policyholder"). Agency will market, place and service the insurance coverage that Policyholder requests, and will act as Policyholder's broker of record for those policies.`,
    );
    writeClauses(w, "Agency", "Policyholder", ["services", "resp", "fees", "term", "conf", "data", "liability", "law", "misc"]);
    w.heading("Consents");
    for (const [t, req] of [
      ["I agree to receive electronic communications, including policy documents and notices.", true],
      ["I have received and read the Agency's Privacy Notice and Compensation Disclosure.", true],
      ["Opt in: send me renewal reminders by text message (optional).", false],
    ]) {
      const base = w.y + 10;
      w.checkbox(w.m + 6, base, t, { role: "client", note: t.slice(0, 30), required: req });
      w.y += 20;
    }
    w.advance(18);
    w.ensure(170);
    let base = w.y + 10;
    w.labeled("Policyholder Signature:", w.m, base, 300, { type: "signature", role: "client", note: "Policyholder Signature" });
    w.labeled("Date:", w.m + 330, base, 138, { type: "date", role: "client", note: "Policyholder Date" });
    base += 28;
    w.labeled("Printed Name:", w.m, base, 300, { type: "name", role: "client", note: "Printed Name" });
    base += 40;
    w.text("FOR THE AGENCY", w.m, base, { font: w.bold });
    base += 30;
    w.labeled("Licensed Agent Signature:", w.m, base, 300, { type: "signature", role: "firm", note: "Licensed Agent Signature" });
    w.labeled("Date:", w.m + 330, base, 138, { type: "date", role: "firm", note: "Agency Date" });
    w.y = base + 20;
  },
);

// 09: no signature line at all
await pdfFixture(
  "09-no-signature",
  {
    firmName: "Bluefield Design Studio LLC",
    description: "2-page Letter, TimesRoman 11. Standard terms with no signature line, no blanks (acceptance by conduct). Detector should warn.",
    warnings: ["No client signature"],
    pageRange: [2, 2],
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER, footer: pageNum("Bluefield Design Studio Standard Terms  |  ") },
  (w) => {
    w.title("STANDARD TERMS OF ENGAGEMENT", 14);
    w.para(
      `These Standard Terms of Engagement apply to all design work performed by Bluefield Design Studio LLC ("Studio") for its clients ("Client"). By approving a proposal or paying a deposit, Client accepts these terms. The signed proposal, if any, controls over these terms.`,
    );
    writeClauses(w, "Studio", "Client", ["services", "resp", "fees", "expenses", "taxes", "term", "conf", "ip", "warranty", "disclaimer", "liability", "contractor", "law", "notices", "misc"]);
    w.para("Questions about these terms can be sent to hello@bluefield.example.com.");
  },
);

// 10: signature block alone on its own last page
await pdfFixture(
  "10-signature-page-alone",
  {
    firmName: "Granite Peak Advisors, Inc.",
    description:
      "4-page Letter, Helvetica 10.5. Page 3 ends with '[Signature page follows.]'; page 4 holds only the signature page: firm block 'GRANITE PEAK ADVISORS, INC.' then 'CLIENT' block with 'Client Legal Name:', By/Name/Title/Email/Date. Labels and underscores are separate items in aligned columns.",
    pageRange: [4, 4],
  },
  { font: "Helvetica", fontSize: 10.5, pageSize: LETTER, footer: pageNum("") },
  async (w) => {
    w.title("INVESTMENT ADVISORY ENGAGEMENT AGREEMENT", 13);
    w.para(
      `This Investment Advisory Engagement Agreement is entered into by Granite Peak Advisors, Inc. ("Advisor") and the client identified on the signature page ("Client"). Advisor will provide non-discretionary investment advice regarding the accounts Client designates.`,
    );
    writeClauses(w, "Advisor", "Client", ["services", "resp", "fees", "expenses", "taxes", "term", "conf", "warranty", "disclaimer", "liability", "indemnity", "data", "notices", "law", "misc"], {
      para: { size: 10.5 },
    });
    // force the boilerplate to end on page 3
    while (w.pages.length < 3) {
      w.para(
        `Advisor's Form ADV Part 2A brochure describes Advisor's services, fees, conflicts of interest and disciplinary history, if any. Client acknowledges receiving the brochure at least forty-eight (48) hours before signing this Agreement.`,
      );
    }
    w.advance(6);
    w.para("[Signature page follows.]", { align: "center" });
    w.newPage();
    w.title("SIGNATURE PAGE", 13, 4);
    w.para("IN WITNESS WHEREOF, the parties have executed this Investment Advisory Engagement Agreement as of the date written below.", { align: "center" });
    w.advance(16);
    const firmRows = [
      { label: "By:", type: "signature" },
      { label: "Name:", type: "name" },
      { label: "Title:", type: "title" },
      { label: "Date:", type: "date" },
    ];
    sigStack(w, "GRANITE PEAK ADVISORS, INC.", firmRows, "firm", { style: "aligned", labelW: 110, lineW: 240, rowH: 30 });
    w.advance(10);
    sigStack(
      w,
      "CLIENT",
      [
        { label: "Client Legal Name:", type: "company", extra: { acceptRoles: ["prefill"], acceptTypes: ["name"] } },
        { label: "By:", type: "signature" },
        { label: "Name:", type: "name" },
        { label: "Title:", type: "title" },
        { label: "Email:", type: "email" },
        { label: "Date:", type: "date" },
      ],
      "client",
      { style: "aligned", labelW: 110, lineW: 240, rowH: 30 },
    );
    if (w.pages.length !== 4) throw new Error("10: signature page overflowed");
  },
);

// 11: fully scanned (image only, no text layer)
await pdfFixture(
  "11-scanned-image-only",
  {
    firmName: "Copperleaf Analytics, Inc.",
    description: "2-page Letter, image-only (embedded grayscale PNG of a 'scan'), no text layer at all. Page 2 visually has a client and firm signature block.",
    warnings: ["selectable text"],
    pages: 2,
    note: "No fields expected: the detector cannot see an image-only document; the right behaviour is the scan warning (place by hand / add a signature page).",
  },
  { pageSize: LETTER },
  async (w, pdf) => {
    const [W, H] = LETTER;
    const r1p = new Raster(W, H, 11);
    r1p.words(W / 2 - 110, W / 2 + 110, 90, 14);
    let b = 130;
    for (let k = 0; k < 7; k++) b = r1p.para(72, W - 72, b, 10, 5 + (k % 3)) + 12;
    await drawRaster(pdf, w.page, r1p);
    w.newPage();
    const r2 = new Raster(W, H, 12);
    b = r2.para(72, W - 72, 90, 10, 9) + 30;
    r2.words(72, 180, b, 10);
    r2.line(72, 300, b + 50);
    r2.words(72, 130, b + 64, 8);
    r2.line(340, 480, b + 50);
    r2.words(340, 370, b + 64, 8);
    b += 120;
    r2.words(72, 260, b, 10);
    r2.line(72, 300, b + 50);
    r2.words(72, 130, b + 64, 8);
    await drawRaster(pdf, w.page, r2);
  },
);

// 12: text pages + a scanned signature page (the signed page was printed and scanned back in)
await pdfFixture(
  "12-mixed-scanned-signature-page",
  {
    firmName: "Riverbend Engineering Group, LLC",
    description:
      "3-page Letter, TimesRoman 10.5. Pages 1-2 have a text layer; page 3 (signature page) is an image-only scan with a client block (signature/name/date lines) and a firm signature line. Document has plenty of text overall, so the scan warning does not fire.",
    warnings: ["No client signature"],
    pages: 3,
    note: "Expected fields on page 3 are true ground truth but invisible to a text-layer detector: they should show up as FN. A good detector should at least flag the text-less page.",
  },
  { font: "TimesRoman", fontSize: 10.5, pageSize: LETTER, footer: (w, i) => i < 2 && pageNum("")(w, i, 3) },
  async (w, pdf) => {
    w.title("PROFESSIONAL ENGINEERING SERVICES AGREEMENT", 13);
    w.para(
      `This Professional Engineering Services Agreement is between Riverbend Engineering Group, LLC ("Engineer") and the client named on the signature page ("Client"). Engineer will perform the structural engineering services described in the attached proposal.`,
    );
    writeClauses(w, "Engineer", "Client", ["services", "resp", "fees", "expenses", "term", "conf", "ip", "warranty", "liability", "indemnity", "insurance", "law", "misc"]);
    while (w.pages.length < 2) w.para("Engineer's services are limited to those expressly described in the proposal. Construction means and methods remain the responsibility of the contractor.");
    w.newPage();
    const [W, H] = LETTER;
    const r = new Raster(W, H, 33);
    r.words(W / 2 - 80, W / 2 + 80, 90, 13);
    let b = r.para(72, W - 72, 130, 10, 3) + 30;
    r.words(72, 120, b, 10); // "CLIENT"
    const sigY = b + 46;
    r.line(72, 300, sigY);
    r.words(72, 125, sigY + 13, 8);
    r.line(340, 500, sigY);
    r.words(340, 365, sigY + 13, 8);
    const nameY = sigY + 44;
    r.line(72, 300, nameY);
    r.words(72, 140, nameY + 13, 8);
    b = nameY + 50;
    r.words(72, 300, b, 10); // firm name heading
    const fY = b + 46;
    r.line(72, 300, fY);
    r.words(72, 125, fY + 13, 8);
    await drawRaster(pdf, w.page, r);
    const pi = 2;
    w.expect({ page: pi, type: "signature", role: "client", x: 72, y: sigY - 24, w: 228, h: 24, note: "scanned client signature" });
    w.expect({ page: pi, type: "date", role: "client", x: 340, y: sigY - 14, w: 160, h: 14, note: "scanned client date" });
    w.expect({ page: pi, type: "name", role: "client", x: 72, y: nameY - 14, w: 228, h: 14, note: "scanned client name" });
    w.expect({ page: pi, type: "signature", role: "firm", x: 72, y: fY - 24, w: 228, h: 24, note: "scanned firm signature" });
  },
);

// 13: engagement letter with filled header lines (traps) and a "Very truly yours" firm block
await pdfFixture(
  "13-engagement-letter-filled-header",
  {
    firmName: "Quill & Ledger CPAs, P.C.",
    description:
      "2-page Letter, TimesRoman 11, letter style. Header 'Date:', 'To:', 'Re:' are ALREADY FILLED with tab-spaced values (traps: no field). Firm signs under 'Very truly yours,' with 'By: ____' and the partner name printed below. Client acknowledgment block 'ACKNOWLEDGED AND AGREED:' with Client Signature / Printed Name / Date.",
    pageRange: [1, 3],
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER },
  (w) => {
    w.text("QUILL & LEDGER CPAS, P.C.", w.m, w.y + 14, { size: 14, font: w.bold });
    w.text("100 Example Avenue, Suite 0  |  Anytown, ST 00000  |  info@quill-ledger.example.com", w.m, w.y + 30, { size: 8.5 });
    w.y += 60;
    for (const [k, v] of [
      ["Date:", "November 5, 2026"],
      ["To:", "Dana Testperson, Testperson Holdings LLC"],
      ["Re:", "Engagement for 2026 Audit of Financial Statements"],
    ]) {
      const base = w.y + 11;
      w.text(k, w.m, base, { font: w.bold });
      w.text(v, w.m + 60, base);
      w.y += 18;
    }
    w.advance(10);
    w.para("Dear Dana Testperson:");
    w.para(
      `This letter confirms our understanding of the terms of our engagement to audit the financial statements of Testperson Holdings LLC (the "Client") for the year ending December 31, 2026. Quill & Ledger CPAs, P.C. ("we" or the "Firm") will conduct the audit in accordance with auditing standards generally accepted in the United States of America.`,
    );
    writeClauses(w, "the Firm", "Client", ["resp", "fees", "term", "conf", "liability", "misc"]);
    w.para("If these terms are acceptable, please sign below and return this letter to us. We appreciate the opportunity to serve you.");
    w.advance(6);
    w.ensure(250);
    let base = w.y + 11;
    w.text("Very truly yours,", w.m, base);
    base += 18;
    w.text("Quill & Ledger CPAs, P.C.", w.m, base);
    base += 34;
    w.labeled("By:", w.m, base, 250, { type: "signature", role: "firm", note: "firm By" });
    base += 15;
    w.text("Morgan Fakename, Partner", w.m + w.wid("By: "), base);
    base += 44;
    w.text("ACKNOWLEDGED AND AGREED:", w.m, base, { font: w.bold });
    base += 18;
    w.text("Testperson Holdings LLC", w.m, base);
    base += 34;
    w.labeled("Client Signature:", w.m, base, 300, { type: "signature", role: "client", note: "Client Signature" });
    base += 28;
    w.labeled("Printed Name:", w.m, base, 300, { type: "name", role: "client", note: "Printed Name" });
    base += 28;
    w.labeled("Date:", w.m, base, 300, { type: "date", role: "client", note: "client Date" });
    w.y = base + 20;
  },
);

// 14: UK style, A4, small font, dot leaders, "SIGNED for and on behalf of", "Position"
await pdfFixture(
  "14-uk-dot-leaders",
  {
    firmName: "Thornbury Digital Ltd",
    description:
      "3-page A4, Helvetica 9. UK style: two columns headed (2 lines each) 'SIGNED for and on behalf of / THORNBURY DIGITAL LTD' and 'SIGNED for and on behalf of / the CLIENT'; rows use dot leaders with no colon: 'Signature ......', 'Name ......', 'Position ......', 'Date ......'.",
    pageRange: [2, 4],
  },
  { font: "Helvetica", fontSize: 9, pageSize: A4, margin: 56, footer: pageNum("Thornbury Digital Ltd - Terms of Business - ") },
  (w) => {
    w.title("TERMS OF BUSINESS", 13);
    w.para(
      `These Terms of Business are made between Thornbury Digital Ltd, company number 00000000, whose registered office is at 1 Example Lane, Exampletown EX1 1EX ("Supplier"), and the client named in the order form ("Client").`,
    );
    writeClauses(w, "the Supplier", "the Client", ["services", "resp", "fees", "expenses", "taxes", "term", "conf", "ip", "warranty", "disclaimer", "liability", "indemnity", "insurance", "nonsolicit", "contractor", "data", "notices", "misc"]);
    w.para("These Terms of Business are governed by the law of England and Wales and the courts of England have exclusive jurisdiction.", { lead: "19. Law." });
    w.advance(14);
    sigColumns(
      w,
      [
        { heading: "SIGNED for and on behalf of\nTHORNBURY DIGITAL LTD", role: "firm" },
        { heading: "SIGNED for and on behalf of\nthe CLIENT", role: "client" },
      ],
      [
        { label: "Signature", type: "signature" },
        { label: "Name", type: "name" },
        { label: "Position", type: "title" },
        { label: "Date", type: "date" },
      ],
      { dots: true, rowH: 28, gap: 30 },
    );
  },
);

// ================================================================= DOCX fixtures (convert later in Docker)
const docxWritten = [];
async function docxFixture(name, meta, children) {
  const doc = new Document({
    creator: "Countersign test corpus (fake data)",
    title: name,
    styles: { default: { document: { run: { font: meta.font ?? "Calibri", size: meta.halfPts ?? 22 } } } },
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(path.join(OUT, name + ".docx"), buf);
  const expected = {
    firmName: meta.firmName,
    description: meta.description,
    source: "docx",
    note: "No coordinates: layout is only known after conversion. Convert to <name>.pdf next to this file (LibreOffice headless); the test then matches by type+role (+page when given).",
    fields: meta.fields,
    warnings: meta.warnings ?? [],
  };
  fs.writeFileSync(path.join(OUT, name + ".expected.json"), JSON.stringify(expected, null, 2) + "\n");
  docxWritten.push(`${name}.docx  (${meta.fields.length} fields, no coords)`);
}
const P = (text, o = {}) => new Paragraph({ spacing: { after: 120 }, ...o, children: [new TextRun({ text, bold: o.bold })] });
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };
const boiler = (F, C, keys) => {
  const c = clauses(F, C);
  return keys.map(
    (k, i) =>
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `${i + 1}. ${c[k][0]} `, bold: true }), new TextRun(c[k][1])],
      }),
  );
};
const cell = (paras, o = {}) => new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: o.borders, children: paras });

// D1: two-column signature table with underscore lines
await docxFixture(
  "15-docx-table-two-column",
  {
    firmName: "Fernway Marketing Co.",
    description: "DOCX, Calibri 11. Two-column borderless signature table: 'FERNWAY MARKETING CO.' | 'CLIENT'; rows By:/Name:/Title:/Date: with underscores.",
    fields: ["signature", "name", "title", "date"].flatMap((type) => [
      { type, role: "firm" },
      { type, role: "client" },
    ]),
  },
  [
    P("MARKETING SERVICES AGREEMENT", { bold: true, alignment: AlignmentType.CENTER }),
    P(
      `This Marketing Services Agreement is between Fernway Marketing Co. ("Agency") and the client identified below ("Client"). Agency will plan and run the campaigns described in each insertion order.`,
    ),
    ...boiler("Agency", "Client", ["services", "fees", "term", "conf", "ip", "liability", "misc"]),
    P("IN WITNESS WHEREOF, the parties have signed this Agreement as of the last date below."),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [
        new TableRow({ children: [cell([P("FERNWAY MARKETING CO.", { bold: true })]), cell([P("CLIENT", { bold: true })])] }),
        ...["By:", "Name:", "Title:", "Date:"].map(
          (l) => new TableRow({ children: [cell([P(`${l} ______________________________`, { spacing: { before: 240 } })]), cell([P(`${l} ______________________________`, { spacing: { before: 240 } })])] }),
        ),
      ],
    }),
  ],
);

// D2: tab-stop based signature line
await docxFixture(
  "16-docx-tabstop-signature",
  {
    firmName: "Hollowell Translation Services LLC",
    description: "DOCX, Times New Roman 12. Client line 'Signature: ____<TAB>Date: ____' built with a tab stop; 'Printed Name: ____' under it; firm line 'Hollowell Translation Services LLC, by: ____<TAB>Date: ____'.",
    font: "Times New Roman",
    halfPts: 24,
    fields: [
      { type: "signature", role: "client" },
      { type: "date", role: "client" },
      { type: "name", role: "client" },
      { type: "signature", role: "firm" },
      { type: "date", role: "firm" },
    ],
  },
  [
    P("TRANSLATION SERVICES ENGAGEMENT", { bold: true, alignment: AlignmentType.CENTER }),
    P(
      `Hollowell Translation Services LLC ("Provider") will translate and certify the documents the client listed below ("Client") delivers, on the terms below.`,
    ),
    ...boiler("Provider", "Client", ["services", "fees", "conf", "liability", "misc"]),
    P("CLIENT", { bold: true, spacing: { before: 360, after: 240 } }),
    new Paragraph({
      tabStops: [{ type: TabStopType.LEFT, position: 5760 }],
      spacing: { after: 360 },
      children: [new TextRun("Signature: ______________________________"), new TextRun({ children: [new Tab(), "Date: ________________"] })],
    }),
    P("Printed Name: ______________________________", { spacing: { after: 480 } }),
    new Paragraph({
      tabStops: [{ type: TabStopType.LEFT, position: 5760 }],
      children: [new TextRun("Hollowell Translation Services LLC, by: ________________"), new TextRun({ children: [new Tab(), "Date: ________________"] })],
    }),
  ],
);

// D3: Word cell-bottom-border lines with captions under them + body blanks
const lineCell = (caption) =>
  new TableCell({
    width: { size: 45, type: WidthType.PERCENTAGE },
    borders: { top: NB, left: NB, right: NB, bottom: NB },
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: noBorders,
        rows: [
          new TableRow({
            children: [new TableCell({ borders: { top: NB, left: NB, right: NB, bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000" } }, children: [P(" ", { spacing: { before: 480 } })] })],
          }),
          new TableRow({ children: [new TableCell({ borders: { top: NB, left: NB, right: NB, bottom: NB }, children: [P(caption)] })] }),
        ],
      }),
    ],
  });
await docxFixture(
  "17-docx-border-lines-body-blanks",
  {
    firmName: "Larkspur Property Management, Inc.",
    description:
      "DOCX, Arial 10. Body blanks ('Client Name: ____', 'Property Address: ____', 'Monthly Fee: $____'). Signature lines are table-cell bottom borders with captions under them ('Signature', 'Date', 'Printed Name'); bold headings 'COMPANY' / 'CLIENT' (defined terms).",
    font: "Arial",
    halfPts: 20,
    fields: [
      { type: "name", role: "prefill" },
      { type: "text", role: "prefill" },
      { type: "text", role: "prefill" },
      { type: "signature", role: "firm" },
      { type: "date", role: "firm" },
      { type: "signature", role: "client" },
      { type: "date", role: "client" },
      { type: "name", role: "client" },
    ],
  },
  [
    P("PROPERTY MANAGEMENT AGREEMENT", { bold: true, alignment: AlignmentType.CENTER }),
    P(
      `This Property Management Agreement is between Larkspur Property Management, Inc. ("Larkspur" or the "Company") and the property owner named below ("Client").`,
    ),
    P("Client Name: ________________________________"),
    P("Property Address: ________________________________________"),
    P("Monthly Fee: $____________ (plus leasing fees in Schedule A)"),
    ...boiler("the Company", "Client", ["services", "resp", "fees", "term", "conf", "liability", "misc"]),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [
        new TableRow({ children: [cell([P("COMPANY", { bold: true })]), cell([P("CLIENT", { bold: true })])] }),
        new TableRow({ children: [lineCell("Signature"), lineCell("Signature")] }),
        new TableRow({ children: [lineCell("Date"), lineCell("Date")] }),
        new TableRow({ children: [cell([P("")]), lineCell("Printed Name")] }),
      ],
    }),
  ],
);

console.log(`wrote ${written.length} PDFs + ${docxWritten.length} DOCX to ${path.relative(ROOT, OUT)}/`);
for (const s of [...written, ...docxWritten]) console.log("  " + s);
