#!/usr/bin/env node
// FINAL test set for the field detector: 8 never-before-seen FAKE client agreements + ground truth.
// Used once, to report honest accuracy. Do not tune the detector against it.
//
//   node scripts/make-final.mjs && FIXTURE_DIR=fixtures/final npx vitest run test/detect.test.ts
//
// Docs 01-04 imitate Google Docs / Word exports of AI / software consulting client agreements;
// 05-08 are other professional-services agreements. All firms, people, emails and addresses are invented.
// Coordinates: PDF points, top-left origin (same as lib/pdf/extract.ts). A field box is the area a
// person writes in: its bottom sits on the blank (underscore baseline + 2pt, or the drawn rule);
// signature 24pt tall, initials 18pt, checkbox = square + 1pt each side, everything else 14pt.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, PageSizes, rgb } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures", "final");
fs.mkdirSync(OUT, { recursive: true });

const LETTER = PageSizes.Letter; // [612, 792]
const A4 = PageSizes.A4; // [595.28, 841.89]
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const FIXED_DATE = new Date("2026-02-20T12:00:00Z");

const r1 = (v) => Math.round(v * 10) / 10;
function fieldH(type) {
  if (type === "signature") return 24;
  if (type === "initials") return 18;
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
    this.ital = fonts[fam + "Italic"];
    this.fs = o.fontSize ?? 10;
    this.lead = o.leading ?? 1.35;
    this.m = o.margin ?? 72;
    this.top = o.top ?? this.m;
    this.bottomM = o.bottom ?? this.m;
    this.paraAfter = o.paraAfter;
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
    this.y = this.top;
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
  text(s, x, base, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    this.page.drawText(s, { x, y: this.H - base, size, font, color: o.color ?? BLACK });
    return x + font.widthOfTextAtSize(s, size);
  }
  expect(f) {
    const e = { page: f.page ?? this.pi, type: f.type, role: f.role, x: r1(f.x), y: r1(f.y), w: r1(f.w), h: r1(f.h) };
    if (f.note) e.note = f.note;
    if (f.acceptRoles) e.acceptRoles = f.acceptRoles;
    if (f.acceptTypes) e.acceptTypes = f.acceptTypes;
    if (f.required === false) e.required = false;
    this.fields.push(e);
  }
  // underscore run as its own text item
  blank(x, base, w, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const uw = font.widthOfTextAtSize("_", size);
    const n = Math.max(3, Math.round(w / uw));
    this.text("_".repeat(n), x, base, o);
    if (field) {
      const h = fieldH(field.type);
      this.expect({ ...field, x, y: base + 2 - h, w: n * uw, h });
    }
    return x + n * uw;
  }
  // "Label ______" as ONE text item
  labeled(label, x, base, totalW, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const lw = font.widthOfTextAtSize(label + " ", size);
    const uw = font.widthOfTextAtSize("_", size);
    const n = Math.max(3, Math.round((totalW - lw) / uw));
    this.text(label + " " + "_".repeat(n), x, base, o);
    if (field) {
      const h = fieldH(field.type);
      this.expect({ ...field, x: x + lw, y: base + 2 - h, w: n * uw, h });
    }
    return x + lw + n * uw;
  }
  // dot leader run as its own text item (label drawn separately by caller)
  dots(x, base, w, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const dw = font.widthOfTextAtSize(".", size);
    const n = Math.max(8, Math.round(w / dw));
    this.text(".".repeat(n), x, base, o);
    if (field) {
      const h = fieldH(field.type);
      this.expect({ ...field, x, y: base + 2 - h, w: n * dw, h });
    }
    return x + n * dw;
  }
  // vector rule at line y `ly` (top-left coords). mode "stroke" = drawn line (Google Docs drawing /
  // horizontal rule); "rect" = thin filled rectangle (how Word exports underlined tabs and cell borders).
  rule(x0, x1, ly, field, o = {}) {
    if (o.mode === "rect") {
      const t = o.thickness ?? 0.5;
      this.page.drawRectangle({ x: x0, y: this.H - ly - t / 2, width: x1 - x0, height: t, color: BLACK });
    } else {
      this.page.drawLine({ start: { x: x0, y: this.H - ly }, end: { x: x1, y: this.H - ly }, thickness: o.thickness ?? 0.75, color: BLACK });
    }
    if (field) {
      const h = fieldH(field.type);
      this.expect({ ...field, x: x0, y: ly - h, w: x1 - x0, h });
    }
  }
  vrule(x, y0, y1, t = 0.5) {
    this.page.drawRectangle({ x: x - t / 2, y: this.H - y1, width: t, height: y1 - y0, color: BLACK });
  }
  // drawn empty checkbox square, top-left at (x, top), side s
  square(x, top, s, field) {
    this.page.drawRectangle({ x, y: this.H - top - s, width: s, height: s, borderColor: BLACK, borderWidth: 0.6 });
    if (field) this.expect({ ...field, type: "checkbox", x: x - 1, y: top - 1, w: s + 2, h: s + 2 });
  }
  // wrapped paragraph. parts: string | {text, font} | {blank: width, field}. o.lead = bold run-in
  // heading, o.num = hanging number drawn at o.numX, o.indent = body indent.
  para(parts, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    if (!Array.isArray(parts)) parts = [parts];
    const toks = [];
    let prevSpace = true;
    if (o.lead) {
      for (const t of o.lead.split(" ")) toks.push({ t, f: o.leadFont ?? this.bold, glue: false });
    }
    for (const p of parts) {
      if (typeof p === "string" || p.text !== undefined) {
        const s = typeof p === "string" ? p : p.text;
        const f = typeof p === "string" ? font : p.font;
        const words = s.split(/\s+/).filter(Boolean);
        words.forEach((t, i) => toks.push({ t, f, glue: i === 0 && toks.length > 0 && !prevSpace && !/^\s/.test(s) }));
        prevSpace = /\s$/.test(s);
      } else {
        const uw = font.widthOfTextAtSize("_", size);
        const n = Math.max(3, Math.round(p.blank / uw));
        toks.push({ blank: n * uw, field: p.field, glue: toks.length > 0 && !prevSpace });
        prevSpace = false;
      }
    }
    const sp = font.widthOfTextAtSize(" ", size);
    const tw = (k) => (k.blank !== undefined ? k.blank : k.f.widthOfTextAtSize(k.t, size));
    const indent = o.indent ?? 0;
    const maxW = this.textW - indent - (o.rightIndent ?? 0);
    const lines = [];
    let cur = [];
    let cw = 0;
    for (const k of toks) {
      const add = (cur.length && !k.glue ? sp : 0) + tw(k);
      if (cur.length && cw + add > maxW) {
        lines.push(cur);
        cur = [];
        cw = 0;
      }
      cw += (cur.length && !k.glue ? sp : 0) + tw(k);
      cur.push(k);
    }
    if (cur.length) lines.push(cur);
    const lh = size * this.lead;
    lines.forEach((ln, li) => {
      this.ensure(lh);
      const base = this.y + size;
      const lineW = ln.reduce((a, k, i) => a + tw(k) + (i && !k.glue ? sp : 0), 0);
      let x = this.m + indent;
      if (o.align === "center") x = (this.W - lineW) / 2;
      if (li === 0 && o.num) this.text(o.num, this.m + (o.numX ?? 0), base, { size, font: o.numFont ?? font });
      let i = 0;
      while (i < ln.length) {
        if (i > 0 && !ln[i].glue) x += sp;
        if (ln[i].blank !== undefined) {
          x = this.blank(x, base, ln[i].blank, ln[i].field, { size, font });
          i++;
          continue;
        }
        let j = i + 1;
        let s = ln[i].t;
        while (j < ln.length && ln[j].blank === undefined && ln[j].f === ln[i].f) {
          s += (ln[j].glue ? "" : " ") + ln[j].t;
          j++;
        }
        x = this.text(s, x, base, { size, font: ln[i].f });
        i = j;
      }
      this.y += lh;
    });
    this.y += o.after ?? this.paraAfter ?? size * 0.6;
  }
  title(s, size = 14, after = 10, font = this.bold) {
    this.ensure(size * 2);
    const w = font.widthOfTextAtSize(s, size);
    this.text(s, (this.W - w) / 2, this.y + size, { size, font });
    this.y += size * 1.35 + after;
  }
  heading(s, o = {}) {
    const size = o.size ?? this.fs + 1;
    this.ensure(size * 4);
    this.y += o.before ?? 6;
    this.text(s, this.m, this.y + size, { size, font: o.font ?? this.bold });
    this.y += size * 1.3 + (o.after ?? 4);
  }
  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      this.footer?.(this, i, n);
    });
  }
}

// numbered section with sub-clauses "3.1", "3.2" (Google Docs / Word numbered list look)
function section(w, num, head, subs, o = {}) {
  w.heading(`${num}. ${head}`, { size: o.headSize ?? w.fs + 1 });
  subs.forEach((s, i) => w.para(s, { num: `${num}.${i + 1}`, indent: o.indent ?? 28, numX: 0 }));
}
// run-in bold headings "4. Confidentiality. Each Party ..."
function runIn(w, num, head, body, o = {}) {
  w.para(body, { lead: `${num}. ${head}`, ...o });
}

// ---------------------------------------------------------------- AI consulting boilerplate
function ai(F, C) {
  const FU = F.toUpperCase();
  const CU = C.toUpperCase();
  return {
    services: [
      `${F} will provide the artificial intelligence automation, workflow design, data integration and knowledge-graph services described in this Agreement and in each statement of work signed by the Parties (each, an "SOW") (collectively, the "Services").`,
      `The Services may include discovery workshops, process mapping, design and configuration of automated workflows, ingestion of ${C}'s documents and records into a knowledge graph, configuration of retrieval and question-answering features, user training, and ongoing monitoring of the deployed solution (the "Solution").`,
      `${F} may engage subcontractors to perform parts of the Services, provided that ${F} remains responsible for their performance and for their compliance with this Agreement.`,
    ],
    platform: [
      `During the Subscription Term, ${F} grants ${C} a non-exclusive, non-transferable right to access and use the hosted platform through which the Solution is delivered (the "Platform") solely for ${C}'s internal business purposes, subject to the usage limits stated in the applicable SOW.`,
      `${C} will not (a) resell or sublicense the Platform, (b) reverse engineer or attempt to extract the source code or model weights of any part of the Platform, (c) use the Platform to build a competing product, or (d) use the Platform in violation of applicable law or any acceptable use policy that ${F} provides in writing.`,
    ],
    data: [
      `${C} retains all right, title and interest in the documents, records and other materials that ${C} or its users submit to the Platform ("Client Data"). ${C} grants ${F} a limited license to host, copy, process, transform and display Client Data solely as needed to provide the Services.`,
      `${F} will not use Client Data to train or fine-tune any general-purpose machine learning model made available to other customers. ${F} may use aggregated, de-identified usage statistics to operate and improve the Platform.`,
      `${C} is responsible for obtaining all consents and giving all notices required for ${F} to process Client Data, and for the accuracy, quality and legality of Client Data.`,
    ],
    outputs: [
      `The Solution uses machine learning models, including large language models provided by third parties, that generate outputs probabilistically. Outputs may be inaccurate, incomplete or inconsistent, and ${C} is responsible for reviewing outputs before relying on them for any decision with legal, financial, medical or similar significance.`,
      `As between the Parties, ${C} owns the outputs generated from Client Data, subject to ${F}'s rights in the Platform and in its pre-existing materials.`,
    ],
    security: [
      `${F} will maintain administrative, physical and technical safeguards designed to protect Client Data against unauthorized access, use or disclosure, including encryption in transit and at rest, role-based access controls and logging of administrative access.`,
      `${F} will notify ${C} without undue delay, and in any event within seventy-two (72) hours, after confirming a security incident affecting Client Data, and will cooperate with ${C}'s reasonable requests for information about the incident.`,
    ],
    invoices: [
      `Invoices are due within thirty (30) days after the invoice date. Late payments bear interest at one percent (1%) per month or the maximum rate permitted by law, whichever is less. Fees exclude taxes, which ${C} will pay, other than taxes on ${F}'s net income.`,
      `Third-party model usage, hosting and API costs that exceed the usage allowance in the applicable SOW will be passed through at cost, as shown in the monthly usage report.`,
    ],
    conf: [
      `Each Party will protect the other Party's non-public business, technical and financial information that is marked or reasonably understood to be confidential ("Confidential Information") with at least reasonable care, will use it only to perform under this Agreement, and will disclose it only to personnel and advisors who need to know it and are bound by obligations no less protective than these.`,
      `These obligations do not apply to information that is or becomes public through no fault of the receiving Party, that the receiving Party already knew or independently developed, or that it lawfully received from a third party without restriction.`,
    ],
    ip: [
      `${F} retains all rights in the Platform, its software, prompts, workflow templates, ontologies, connectors, documentation and know-how, including improvements made while providing the Services ("${F} Materials"). Upon payment in full, ${C} owns the custom deliverables identified in an SOW as belonging to ${C}, excluding ${F} Materials.`,
    ],
    termination: [
      `Either Party may terminate this Agreement on written notice if the other Party materially breaches it and fails to cure the breach within thirty (30) days after receiving written notice. On termination, ${C} will pay all fees accrued through the termination date, and ${F} will make Client Data available for export for thirty (30) days, after which ${F} will delete it.`,
    ],
    warranty: [
      `${F} warrants that it will perform the Services in a professional manner consistent with industry standards. EXCEPT AS EXPRESSLY SET OUT IN THIS AGREEMENT, THE SERVICES, THE PLATFORM AND ALL OUTPUTS ARE PROVIDED "AS IS", AND ${FU} DISCLAIMS ALL IMPLIED WARRANTIES, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.`,
    ],
    liability: [
      `NEITHER PARTY WILL BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE OR DATA, EVEN IF ADVISED OF THEIR POSSIBILITY. EACH PARTY'S TOTAL LIABILITY UNDER THIS AGREEMENT WILL NOT EXCEED THE FEES PAID OR PAYABLE BY ${CU} IN THE TWELVE (12) MONTHS BEFORE THE CLAIM AROSE.`,
    ],
    general: [
      `This Agreement is governed by the laws of the Commonwealth of Massachusetts, excluding its conflict of laws rules, and the Parties submit to the courts located in Suffolk County, Massachusetts.`,
      `This Agreement, together with each SOW, is the entire agreement of the Parties on its subject matter. Amendments must be in writing and signed by both Parties. Neither Party may assign this Agreement without the other's consent, except in connection with a merger or sale of substantially all of its assets.`,
      `This Agreement may be signed electronically and in counterparts, each of which is an original and all of which together are one instrument.`,
    ],
  };
}

// ---------------------------------------------------------------- output
const written = [];
async function pdfFixture(name, meta, opts, draw) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title ?? name);
  pdf.setAuthor("Countersign final test set (fake data)");
  pdf.setProducer(meta.producer ?? "countersign make-final");
  pdf.setCreator(meta.creator ?? "countersign make-final");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const fonts = {
    Helvetica: await pdf.embedFont(StandardFonts.Helvetica),
    HelveticaBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    HelveticaItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    TimesRoman: await pdf.embedFont(StandardFonts.TimesRoman),
    TimesRomanBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    TimesRomanItalic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
  };
  const w = new Writer(pdf, fonts, opts);
  await draw(w, pdf);
  w.finish();
  if (meta.pageRange && (w.pages.length < meta.pageRange[0] || w.pages.length > meta.pageRange[1]))
    throw new Error(`${name}: expected ${meta.pageRange.join("-")} pages, got ${w.pages.length}`);
  for (const f of w.fields) if (f.page >= w.pages.length) throw new Error(`${name}: field on missing page`);
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

// ================================================================= 01  Google Docs, 2-column borderless table
await pdfFixture(
  "01-fakeworth-ai-gdocs-two-column",
  {
    firmName: "Fakeworth AI, LLC",
    creator: "Google Docs",
    producer: "Skia/PDF m128 Google Docs Renderer",
    description:
      "Google-Docs-style export, Helvetica(Arial) 11, Letter. AI automation + knowledge-graph client services agreement. Preamble: Fakeworth AI, LLC (\"Fakeworth\", \"we\") and the client identified below (\"Client\", \"you\"); Effective Date blank in the preamble; 'Client Information' block (legal name/contact/email); fee and term blanks inside running text. Signature: 2-column borderless table, headings 'FAKEWORTH AI, LLC' | 'CLIENT', rows 'Signature: ____' / 'Printed Name: ____' / 'Title: ____' / 'Date: ____' (label+underscores in one text run); client column has an extra 'Company: ____' row.",
    pageRange: [2, 5],
    note: "Client Information + fee/term blanks are prefill (filled from file data); the client could also fill them, so acceptRoles client.",
  },
  {
    font: "Helvetica",
    fontSize: 11,
    pageSize: LETTER,
    margin: 72,
    leading: 1.32,
    paraAfter: 7,
    footer: (w, i) => {
      w.text("Fakeworth AI, LLC  |  Client Services Agreement", w.m, 40, { size: 8, color: GREY });
      const s = String(i + 1);
      w.text(s, w.W - w.m - w.wid(s, { size: 9 }), w.H - 40, { size: 9 });
    },
  },
  (w) => {
    const c = ai("Fakeworth", "Client");
    const pf = (type, note, extra = {}) => ({ type, role: "prefill", acceptRoles: ["client"], note, ...extra });
    w.title("CLIENT SERVICES AGREEMENT", 16, 2);
    w.title("AI Automation & Knowledge Graph Services", 11, 14, w.font);
    w.para([
      'This Client Services Agreement (this "Agreement") is entered into as of ',
      { blank: 100, field: pf("date", "Effective Date blank") },
      ' (the "Effective Date") by and between Fakeworth AI, LLC, a Massachusetts limited liability company ("Fakeworth", "we", "us" or "our"), and the client identified below ("Client", "you" or "your"). Fakeworth and Client are each a "Party" and together the "Parties".',
    ]);
    w.heading("Client Information", { size: 11, before: 4 });
    for (const [label, type, extra] of [
      ["Client legal name:", "company", { acceptTypes: ["name"] }],
      ["Primary contact:", "name", {}],
      ["Contact email:", "email", {}],
      ["Billing address:", "text", {}],
    ]) {
      const base = w.y + 11;
      w.labeled(label, w.m, base, 360, pf(type, label, extra));
      w.y += 22;
    }
    w.advance(4);
    section(w, 1, "Services", c.services);
    section(w, 2, "Fees and Payment", [
      [
        "Client will pay Fakeworth a one-time implementation fee of $",
        { blank: 70, field: pf("text", "implementation fee $____") },
        ' (the "Implementation Fee"), payable on signature, and a platform fee of $',
        { blank: 70, field: pf("text", "platform fee $____") },
        ' per month (the "Platform Fee"), beginning on the go-live date stated in the SOW.',
      ],
      ...c.invoices,
    ]);
    section(w, 3, "Platform Access", c.platform);
    section(w, 4, "Client Data", c.data);
    section(w, 5, "AI Outputs", c.outputs);
    section(w, 6, "Security", c.security);
    section(w, 7, "Confidentiality", c.conf);
    section(w, 8, "Intellectual Property", c.ip);
    section(w, 9, "Term and Termination", [
      [
        "The initial term of this Agreement is ",
        { blank: 40, field: pf("text", "initial term ____ months") },
        ' months from the Effective Date (the "Initial Term") and then renews for successive twelve (12) month periods unless either Party gives notice of non-renewal at least sixty (60) days before the end of the then-current term.',
      ],
      ...c.termination,
    ]);
    section(w, 10, "Warranty and Disclaimer", c.warranty);
    section(w, 11, "Limitation of Liability", c.liability);
    section(w, 12, "General", c.general);
    w.advance(6);
    w.ensure(230);
    w.para("IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.");
    w.advance(8);
    // borderless 2-col table: cell padding 5
    const gap = 20;
    const colW = (w.textW - gap) / 2;
    const xs = [w.m + 5, w.m + colW + gap + 5];
    const cellW = colW - 10;
    let base = w.y + 11;
    w.text("FAKEWORTH AI, LLC", xs[0], base, { font: w.bold });
    w.text("CLIENT", xs[1], base, { font: w.bold });
    base += 30;
    w.labeled("Company:", xs[1], base, cellW, { type: "company", role: "client", acceptRoles: ["prefill"], acceptTypes: ["name"], note: "CLIENT / Company" });
    for (const [label, type] of [
      ["Signature:", "signature"],
      ["Printed Name:", "name"],
      ["Title:", "title"],
      ["Date:", "date"],
    ]) {
      base += 30;
      w.labeled(label, xs[0], base, cellW, { type, role: "firm", note: `FAKEWORTH AI, LLC / ${label}` });
      w.labeled(label, xs[1], base, cellW, { type, role: "client", note: `CLIENT / ${label}` });
    }
    w.y = base + 20;
  },
);

// ================================================================= 02  Word export, order-form table, initials footer, stacked "Agreed and accepted"
await pdfFixture(
  "02-brightloom-kg-word-agreed-accepted",
  {
    firmName: "Brightloom Graph Labs, Inc.",
    creator: "Microsoft® Word for Microsoft 365",
    producer: "Microsoft® Word for Microsoft 365",
    description:
      "Word-style export, Helvetica(Arial) 10, Letter. Knowledge-graph platform subscription + services agreement. Provider = Brightloom Graph Labs, Inc. (\"Brightloom\" or \"Provider\"), Customer. Order Form = bordered table (cell borders as thin filled rects) with EMPTY value cells. Footer on every page: 'Customer Initials: ____   Provider Initials: ____'. Last page: stacked 'AGREED AND ACCEPTED:' block, CUSTOMER first then BRIGHTLOOM GRAPH LABS, INC.; 'Company:'/'By:'/'Name:'/'Title:'/'Date:' labels followed by underlined tabs (thin filled rects, no underscores).",
    pageRange: [3, 5],
    note: "Order-form value cells are empty bordered table cells (no underscores): prefill, client may also fill. Provider initials are the firm's.",
  },
  {
    font: "Helvetica",
    fontSize: 10,
    pageSize: LETTER,
    margin: 72,
    bottom: 96,
    leading: 1.3,
    paraAfter: 6,
    footer: (w, i, n) => {
      const base = w.H - 58;
      const x2 = w.W - w.m - 140;
      const x1 = x2 - 165;
      w.text("Customer Initials:", x1, base, { size: 9 });
      w.blank(x1 + w.wid("Customer Initials: ", { size: 9 }), base, 60, { type: "initials", role: "client", note: `Customer Initials p${i + 1}` }, { size: 9 });
      w.text("Provider Initials:", x2, base, { size: 9 });
      w.blank(x2 + w.wid("Provider Initials: ", { size: 9 }), base, 60, { type: "initials", role: "firm", note: `Provider Initials p${i + 1}` }, { size: 9 });
      const s = `Brightloom Graph Labs, Inc. - Platform Subscription and Services Agreement (rev. 03/2026)        Page ${i + 1} of ${n}`;
      w.text(s, w.m, w.H - 38, { size: 7.5, color: GREY });
    },
  },
  (w) => {
    const c = ai("Provider", "Customer");
    w.title("PLATFORM SUBSCRIPTION AND SERVICES AGREEMENT", 13, 12);
    w.para(
      'This Platform Subscription and Services Agreement (the "Agreement") is made between Brightloom Graph Labs, Inc., a Delaware corporation ("Brightloom" or "Provider"), and the customer named in the Order Form below ("Customer"). By signing below, Customer agrees to the Order Form and to the Terms and Conditions that follow it.',
    );
    w.heading("ORDER FORM", { size: 10.5, before: 6 });
    // bordered table: label col + value col
    const x0 = w.m,
      x1 = w.m + 190,
      x2 = w.W - w.m;
    const rowH = 21;
    const rows = [
      ["Customer legal name", "company", { acceptTypes: ["name"] }, ""],
      ["Customer contact name", "name", {}, ""],
      ["Customer contact email", "email", {}, ""],
      ["Subscription start date", "date", {}, ""],
      ["Annual platform subscription fee", "text", {}, "US$"],
      ["Implementation services fee (one-time)", "text", {}, "US$"],
    ];
    let top = w.y;
    w.rule(x0, x2, top, null, { mode: "rect" });
    rows.forEach(([label, type, extra, prefix], k) => {
      const bot = top + rowH;
      const base = bot - 6;
      w.text(label, x0 + 5, base, { font: w.bold, size: 9.5 });
      let fx = x1 + 5;
      if (prefix) fx = w.text(prefix, fx, base, { size: 9.5 }) + 3;
      w.expect({ type, role: "prefill", acceptRoles: ["client"], note: `Order Form / ${label}`, x: fx, y: bot - 3 - 14, w: x2 - 5 - fx, h: 14, ...extra });
      w.rule(x0, x2, bot, null, { mode: "rect" });
      top = bot;
      void k;
    });
    w.vrule(x0, w.y, top);
    w.vrule(x1, w.y, top);
    w.vrule(x2, w.y, top);
    w.y = top + 10;
    w.para(
      "The fees above are exclusive of taxes and are invoiced annually in advance (subscription) and on signature (implementation). Usage above the included allowance of 50,000 document pages and 20,000 assistant queries per month is billed at the rates in Provider's then-current price list.",
      { size: 9 },
    );
    w.heading("TERMS AND CONDITIONS", { size: 10.5, before: 8 });
    const items = [
      ["Services.", c.services.join(" ")],
      ["Subscription.", c.platform.join(" ")],
      ["Customer Data.", c.data.join(" ")],
      ["AI Outputs.", c.outputs.join(" ")],
      ["Security.", c.security.join(" ")],
      ["Fees and Payment.", c.invoices.join(" ")],
      ["Confidentiality.", c.conf.join(" ")],
      ["Intellectual Property.", c.ip.join(" ")],
      [
        "Term.",
        'The subscription term begins on the subscription start date in the Order Form and continues for twelve (12) months (the "Subscription Term"). It renews automatically for further twelve (12) month terms unless either party gives notice of non-renewal at least thirty (30) days before renewal. ' +
          c.termination[0],
      ],
      ["Warranty.", c.warranty[0]],
      ["Limitation of Liability.", c.liability[0]],
      ["General.", c.general.join(" ")],
    ];
    items.forEach(([h, b], i) => runIn(w, i + 1, h, b));
    w.advance(8);
    w.ensure(330);
    w.text("AGREED AND ACCEPTED:", w.m, w.y + 10, { font: w.bold });
    w.y += 26;
    const block = (heading, role, rowsB) => {
      let base = w.y + 10;
      w.text(heading, w.m, base, { font: w.bold });
      for (const [label, type, extra] of rowsB) {
        base += 26;
        w.text(label, w.m, base);
        w.rule(w.m + 62, w.m + 300, base + 2, { type, role, note: `${heading} / ${label}`, ...extra }, { mode: "rect", thickness: 0.5 });
      }
      w.y = base + 26;
    };
    const std = [
      ["By:", "signature", {}],
      ["Name:", "name", {}],
      ["Title:", "title", {}],
      ["Date:", "date", {}],
    ];
    block("CUSTOMER", "client", [["Company:", "company", { acceptRoles: ["prefill"], acceptTypes: ["name"] }], ...std]);
    block("BRIGHTLOOM GRAPH LABS, INC.", "firm", std);
  },
);

// ================================================================= 03  Google Docs A4: one-line client signature, "Authorized Signatory" firm block
await pdfFixture(
  "03-halcyon-automation-gdocs-one-line",
  {
    firmName: "Halcyon Automation Partners LLC",
    creator: "Google Docs",
    producer: "Skia/PDF m128 Google Docs Renderer",
    description:
      "Google-Docs-style export, Helvetica(Arial) 10.5, A4. AI workflow-automation consulting agreement; Halcyon Automation Partners LLC (\"Halcyon\", \"we\") and \"Client\"/\"you\". Fee schedule as a bullet list with $____ blanks. Signature: client lines are single text runs 'Client Signature ______  Date ______', 'Client Name (print) ______', 'Client Company ______' (no colons); firm block 'For and on behalf of Halcyon Automation Partners LLC:' then a bare underscore line with caption 'Authorized Signatory' under it, a PRE-PRINTED 'Name: Rowan Fakerly' (no field) and 'Date: ____'.",
    pageRange: [2, 4],
  },
  {
    font: "Helvetica",
    fontSize: 10.5,
    pageSize: A4,
    margin: 72,
    leading: 1.3,
    paraAfter: 6,
    footer: (w, i, n) => {
      const s = `Page ${i + 1} of ${n}`;
      w.text(s, (w.W - w.wid(s, { size: 9 })) / 2, w.H - 36, { size: 9 });
    },
  },
  (w) => {
    const c = ai("Halcyon", "Client");
    w.text("HALCYON AUTOMATION PARTNERS", w.m, w.y + 12, { size: 12, font: w.bold });
    w.text("workflow automation  ·  AI agents  ·  knowledge systems".replace(/·/g, "|"), w.m, w.y + 26, { size: 8.5, color: GREY });
    w.y += 46;
    w.title("Consulting Services Agreement", 15, 8, w.bold);
    w.para(
      'This Consulting Services Agreement (the "Agreement") is between Halcyon Automation Partners LLC ("Halcyon", "we" or "us") and you, the client named in the signature section below ("Client" or "you"). It takes effect on the date Client signs it (the "Effective Date").',
    );
    section(w, 1, "What we will do", [
      "Halcyon will review Client's current operating processes, identify tasks suitable for automation, and design, build and deploy AI agents and automated workflows that connect Client's existing business systems (the \"Automations\").",
      ...c.services.slice(2),
      "Each phase of work will be described in a short written project plan that both parties approve by email before work on that phase begins.",
    ]);
    section(w, 2, "Fees", [
      "Client will pay the following fees:",
    ]);
    const bullet = (parts) => w.para(parts, { num: "•", numX: 30, indent: 44, after: 3 });
    bullet(["Discovery and process-mapping workshop: $", { blank: 70, field: { type: "text", role: "prefill", acceptRoles: ["client"], note: "workshop fee $____" } }, " (fixed fee)"]);
    bullet(["Build and deployment of the Automations: $", { blank: 70, field: { type: "text", role: "prefill", acceptRoles: ["client"], note: "build fee $____" } }, " per phase"]);
    bullet(["Ongoing support and monitoring: included for the first ninety (90) days after go-live"]);
    w.advance(4);
    w.para(c.invoices[0], { num: "2.2", indent: 28 });
    w.para(c.invoices[1], { num: "2.3", indent: 28 });
    section(w, 3, "Your data", c.data);
    section(w, 4, "AI-generated output", c.outputs);
    section(w, 5, "Confidentiality and security", [c.conf[0], c.security[0]]);
    section(w, 6, "Ownership", c.ip);
    section(w, 7, "Ending this Agreement", [
      "Either party may end this Agreement for any reason on thirty (30) days' written notice, including by email.",
      ...c.termination,
    ]);
    section(w, 8, "Warranty and liability", [c.warranty[0], c.liability[0]]);
    section(w, 9, "General", c.general);
    w.advance(10);
    w.ensure(250);
    w.heading("Signatures", { size: 11.5 });
    w.para("By signing below, Client confirms that it has read and agrees to this Agreement.");
    w.advance(14);
    let base = w.y + 10.5;
    // one text run: "Client Signature ______  Date ______"
    {
      const a = "Client Signature ";
      const uw = w.wid("_");
      const n1 = 30,
        n2 = 14;
      const s = a + "_".repeat(n1) + "   Date " + "_".repeat(n2);
      w.text(s, w.m, base);
      const sx = w.m + w.wid(a);
      w.expect({ type: "signature", role: "client", note: "Client Signature", x: sx, y: base + 2 - 24, w: n1 * uw, h: 24 });
      const dx = sx + n1 * uw + w.wid("   Date ");
      w.expect({ type: "date", role: "client", note: "client Date", x: dx, y: base + 2 - 14, w: n2 * uw, h: 14 });
    }
    base += 30;
    w.labeled("Client Name (print)", w.m, base, 300, { type: "name", role: "client", note: "Client Name (print)" });
    base += 30;
    w.labeled("Client Company", w.m, base, 300, { type: "company", role: "client", acceptRoles: ["prefill"], acceptTypes: ["name"], note: "Client Company" });
    base += 46;
    w.text("For and on behalf of Halcyon Automation Partners LLC:", w.m, base);
    base += 38;
    w.blank(w.m, base, 220, { type: "signature", role: "firm", note: "Authorized Signatory line" });
    base += 14;
    w.text("Authorized Signatory", w.m, base, { size: 9 });
    base += 22;
    w.text("Name: Rowan Fakerly, Managing Partner", w.m, base);
    base += 26;
    w.labeled("Date:", w.m, base, 180, { type: "date", role: "firm", note: "firm Date" });
    w.y = base + 20;
  },
);

// ================================================================= 04  Word export: drawn rules with captions under, checkboxes, inline initials
await pdfFixture(
  "04-verdant-ai-consulting-word-rules",
  {
    firmName: "Verdant Loop AI Consulting, LLC",
    creator: "Microsoft® Word 2021",
    producer: "Microsoft® Word 2021",
    description:
      "Word-style export, Helvetica(Arial) 10, Letter. AI strategy + LLM-assistant implementation engagement; \"Consultant\" (Verdant Loop AI Consulting, LLC, \"Verdant\") and \"Client\". Support-plan choice = three drawn checkbox squares. Inline 'Client initials: ______' at the end of the liability section. Signature: two side-by-side columns under headings 'VERDANT LOOP AI CONSULTING, LLC' | 'CLIENT'; each field is a stroked vector line with an 8pt caption UNDER it ('Signature', 'Name', 'Title', 'Date'); no colons, no underscores.",
    pageRange: [2, 4],
  },
  {
    font: "Helvetica",
    fontSize: 10,
    pageSize: LETTER,
    margin: 72,
    leading: 1.35,
    paraAfter: 6,
    footer: (w, i) => {
      const t = "CONFIDENTIAL";
      w.text(t, w.W - w.m - w.wid(t, { size: 8 }), 42, { size: 8, color: GREY });
      w.text(`Verdant Loop AI Consulting, LLC  -  Engagement Agreement  -  ${i + 1}`, w.m, w.H - 40, { size: 8, color: GREY });
    },
  },
  (w) => {
    const c = ai("Consultant", "Client");
    w.title("AI CONSULTING ENGAGEMENT AGREEMENT", 14, 12);
    w.para(
      'This AI Consulting Engagement Agreement (the "Agreement") is entered into by and between Verdant Loop AI Consulting, LLC, a Colorado limited liability company ("Verdant" or "Consultant"), and the organization signing below as client ("Client"). Consultant will help Client plan, build and roll out large-language-model assistants and automation over Client\'s internal knowledge.',
    );
    const items = [
      ["Scope of Engagement.", c.services.join(" ")],
      ["Client Data.", c.data.slice(0, 2).join(" ")],
      ["Model Outputs.", c.outputs.join(" ")],
      [
        "Fees.",
        "Consultant's fees are set out in the proposal accepted by Client and are billed monthly for time and materials at the rates in that proposal, plus approved expenses at cost. " + c.invoices[0],
      ],
    ];
    items.forEach(([h, b], i) => runIn(w, i + 1, h, b));
    runIn(w, 5, "Support Plan.", "After go-live, Client selects the following support plan (check one):", { after: 6 });
    for (const [label, req] of [
      ["Standard support - business-hours email support, monthly model and prompt review", true],
      ["Priority support - four-hour response, weekly evaluation report, quarterly re-indexing", true],
      ["No ongoing support - Consultant's obligations end at go-live", true],
    ]) {
      const top = w.y + 1;
      w.square(w.m + 20, top, 9, { role: "client", note: `Support plan: ${label.slice(0, 24)}` });
      w.text(label, w.m + 36, top + 8.2);
      w.y += 18;
    }
    w.advance(6);
    const rest = [
      ["Confidentiality.", c.conf.join(" ")],
      ["Security.", c.security.join(" ")],
      ["Intellectual Property.", c.ip[0]],
      ["Termination.", "Either party may terminate this Agreement for convenience on twenty (20) days' written notice. " + c.termination[0]],
      ["Warranty.", c.warranty[0]],
      ["Limitation of Liability.", c.liability[0]],
    ];
    rest.forEach(([h, b], i) => runIn(w, i + 6, h, b));
    {
      w.ensure(30);
      const base = w.y + 10;
      const lbl = "Client initials:";
      const x = w.W - w.m - 150;
      w.text(lbl, x, base, { font: w.bold });
      w.blank(x + w.wid(lbl + " ", { font: w.bold }), base, 150 - w.wid(lbl + " ", { font: w.bold }), { type: "initials", role: "client", note: "inline initials after liability" });
      w.y += 26;
    }
    runIn(w, 12, "General.", c.general.join(" "));
    w.advance(12);
    w.ensure(250);
    w.para("The parties have signed this Agreement by their authorized representatives as of the later of the dates below.");
    w.advance(10);
    const gap = 36;
    const colW = (w.textW - gap) / 2;
    const xs = [w.m, w.m + colW + gap];
    const headBase = w.y + 10;
    w.text("VERDANT LOOP AI CONSULTING, LLC", xs[0], headBase, { font: w.bold });
    w.text("CLIENT", xs[1], headBase, { font: w.bold });
    let ly = headBase + 40;
    for (const [cap, type] of [
      ["Signature", "signature"],
      ["Name", "name"],
      ["Title", "title"],
      ["Date", "date"],
    ]) {
      [
        ["firm", "VERDANT LOOP AI CONSULTING, LLC"],
        ["client", "CLIENT"],
      ].forEach(([role, head], k) => {
        w.rule(xs[k], xs[k] + colW, ly, { type, role, note: `${head} / ${cap}` }, { thickness: 0.6 });
        w.text(cap, xs[k], ly + 10, { size: 8 });
      });
      ly += type === "signature" ? 40 : 34;
    }
    w.y = ly;
  },
);

// ================================================================= 05  property management (Times, Letter, captions under underscores, "Its:")
await pdfFixture(
  "05-fakeview-property-management",
  {
    firmName: "Fakeview Property Management, Inc.",
    description:
      "Residential property management agreement, TimesRoman 11, Letter, 2-3 pages. Manager = Fakeview Property Management, Inc. (\"Manager\"); client = \"Owner\". Property / fee blanks in the body ('Property address: ____', '____% of gross rents', 'Commencement date: ____'). Signature: 'OWNER:' block = bare underscore line + 'Date: ____' on the same line, caption 'Owner Signature' under it, then bare line + caption 'Print Name', then 'Email: ____'. 'MANAGER:' block: 'Fakeview Property Management, Inc.' then 'By: ____  Date: ____' and 'Its: ____' (title).",
    pageRange: [2, 4],
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER, margin: 72, leading: 1.4, paraAfter: 7, footer: (w, i, n) => w.text(`Owner-Manager Agreement  |  Page ${i + 1} of ${n}`, w.m, w.H - 40, { size: 8.5, font: w.ital }) },
  (w) => {
    const pf = (type, note) => ({ type, role: "prefill", acceptRoles: ["client"], note });
    w.title("PROPERTY MANAGEMENT AGREEMENT", 15, 12);
    w.para(
      'THIS PROPERTY MANAGEMENT AGREEMENT (the "Agreement") is made between the undersigned owner(s) of the property described below ("Owner") and Fakeview Property Management, Inc., a licensed real estate brokerage ("Manager"). Owner appoints Manager as the exclusive managing agent of the Property on the terms below.',
    );
    w.heading("1. THE PROPERTY", { size: 11 });
    {
      let base = w.y + 11;
      w.labeled("Property address:", w.m + 18, base, 420, pf("text", "Property address"));
      base += 24;
      w.labeled("Number of units:", w.m + 18, base, 180, pf("text", "Number of units"));
      w.y = base + 12;
    }
    w.heading("2. TERM", { size: 11 });
    w.para([
      "This Agreement begins on ",
      { blank: 110, field: pf("date", "Commencement date") },
      ' (the "Commencement Date") and continues for one (1) year, renewing month to month afterward until either party gives sixty (60) days\' written notice of termination.',
    ]);
    w.heading("3. MANAGEMENT FEES", { size: 11 });
    w.para([
      "Owner will pay Manager a monthly management fee equal to ",
      { blank: 34, field: pf("text", "management fee ____%") },
      "% of gross rents collected, and a leasing fee of $",
      { blank: 70, field: pf("text", "leasing fee $____") },
      " for each new lease signed. Manager may deduct its fees from rents collected before remitting the balance to Owner.",
    ]);
    const secs = [
      ["4. MANAGER'S DUTIES", [
        "Manager will advertise vacancies, screen prospective tenants in compliance with fair housing laws, negotiate and sign leases on Owner's behalf within the rent guidelines Owner approves, collect rents and security deposits, and hold security deposits in a trust account as required by law.",
        "Manager will arrange routine maintenance and repairs, respond to tenant maintenance requests, and conduct a move-in and move-out inspection of each unit. Manager will not authorize any single repair exceeding five hundred dollars ($500) without Owner's prior approval, except in an emergency that threatens health, safety or the Property.",
        "Manager will provide Owner with a monthly statement of income and expenses by the fifteenth (15th) day of each month and an annual summary suitable for tax preparation.",
      ]],
      ["5. OWNER'S DUTIES", [
        "Owner will maintain property and liability insurance on the Property naming Manager as an additional insured, will keep a reserve of not less than one thousand dollars ($1,000) with Manager for repairs, and will disclose to Manager all known material defects, including lead-based paint where applicable.",
        "Owner will not interfere with tenants' quiet enjoyment or deal directly with tenants regarding matters Manager is handling, and will promptly refer any tenant communications to Manager.",
      ]],
      ["6. INDEMNIFICATION", [
        "Owner will indemnify and hold Manager harmless from claims, losses and expenses arising from the condition of the Property or Owner's acts, except to the extent caused by Manager's negligence or willful misconduct. Manager will indemnify Owner against claims arising from Manager's negligence or willful misconduct in performing its duties.",
      ]],
      ["7. TERMINATION", [
        "Either party may terminate this Agreement for cause on fifteen (15) days' written notice if the other party materially breaches it. On termination, Manager will deliver to Owner all security deposits, leases, keys and records relating to the Property within thirty (30) days, and will be paid any fees earned through the termination date.",
      ]],
      ["8. GENERAL PROVISIONS", [
        "This Agreement is governed by the laws of the state in which the Property is located. It is the entire agreement of the parties and may be amended only in writing signed by both parties. Notices may be given by email to the addresses below. If any provision is held unenforceable, the rest of this Agreement remains in effect.",
        "Manager is an independent contractor. Nothing in this Agreement makes Manager an employee or partner of Owner. Manager may perform services for other property owners, including owners of properties that compete with the Property.",
      ]],
    ];
    for (const [h, ps] of secs) {
      w.heading(h, { size: 11 });
      for (const p of ps) w.para(p);
    }
    w.advance(10);
    w.ensure(300);
    w.para("IN WITNESS WHEREOF, Owner and Manager have signed this Agreement on the dates below.");
    w.advance(10);
    let base = w.y + 11;
    w.text("OWNER:", w.m, base, { font: w.bold });
    base += 40;
    w.blank(w.m, base, 250, { type: "signature", role: "client", note: "Owner Signature" });
    w.labeled("Date:", w.m + 290, base, 150, { type: "date", role: "client", note: "Owner Date" });
    w.text("Owner Signature", w.m, base + 13, { size: 9, font: w.ital });
    base += 40;
    w.blank(w.m, base, 250, { type: "name", role: "client", note: "Print Name" });
    w.text("Print Name", w.m, base + 13, { size: 9, font: w.ital });
    base += 34;
    w.labeled("Email:", w.m, base, 250, { type: "email", role: "client", acceptRoles: ["prefill"], note: "Owner Email" });
    base += 44;
    w.text("MANAGER:", w.m, base, { font: w.bold });
    base += 16;
    w.text("Fakeview Property Management, Inc.", w.m, base);
    base += 34;
    w.labeled("By:", w.m, base, 250, { type: "signature", role: "firm", note: "Manager By" });
    w.labeled("Date:", w.m + 290, base, 150, { type: "date", role: "firm", note: "Manager Date" });
    base += 30;
    w.labeled("Its:", w.m, base, 250, { type: "title", role: "firm", note: "Manager Its (title)" });
    w.y = base + 20;
  },
);

// ================================================================= 06  event planning, UK A4, dot leaders, "(Client)" after the line
await pdfFixture(
  "06-fakefield-events-uk-dots",
  {
    firmName: "Fakefield Events Ltd",
    description:
      "Event planning booking contract, UK style, Helvetica 9.5, A4, 2 pages. Booking details with dot leaders ('Event date', 'Venue', 'Estimated guests', 'Deposit (30%) £'). Signature lines: 'Signed ........ (Client)   Date ......', 'Print name ........', then 'Signed ........ (for and on behalf of Fakefield Events Ltd)' with 'Date ......' on the next line. Role is given only by the parenthetical AFTER the dots.",
    pageRange: [1, 3],
  },
  { font: "Helvetica", fontSize: 9.5, pageSize: A4, margin: 54, leading: 1.38, paraAfter: 5, footer: (w, i, n) => w.text(`Fakefield Events Ltd  -  Booking Terms  -  ${i + 1}/${n}`, w.m, w.H - 30, { size: 7.5, color: GREY }) },
  (w) => {
    w.text("FAKEFIELD EVENTS", w.m, w.y + 16, { size: 18, font: w.bold });
    w.text("Weddings  |  Corporate  |  Private celebrations", w.m, w.y + 30, { size: 8.5, color: GREY });
    w.y += 50;
    w.title("EVENT BOOKING CONTRACT", 13, 8);
    w.para(
      'This contract is between Fakefield Events Ltd, a company registered in England and Wales under number 00000000 ("we", "us", "the Planner"), and the person or organisation named as the client below ("you", "the Client"). It confirms the event planning services we will provide for your event.',
    );
    w.heading("Booking details", { size: 10.5 });
    const pf = (type, note) => ({ type, role: "prefill", acceptRoles: ["client"], note });
    for (const [label, type, wd] of [
      ["Event date", "date", 160],
      ["Venue", "text", 300],
      ["Estimated guests", "text", 100],
      ["Deposit (30%)  £", "text", 120],
    ]) {
      const base = w.y + 10;
      w.text(label, w.m, base);
      w.dots(w.m + 110, base, wd, pf(type, label));
      w.y += 20;
    }
    w.advance(6);
    const terms = [
      ["Our services.", "We will plan and coordinate your event as set out in the event proposal we have sent you, including supplier sourcing, scheduling, a site visit, a run-of-show document and on-the-day coordination by a lead planner and an assistant."],
      ["Deposit and payment.", "The deposit shown above is payable on signing and secures your date. The balance of our fee is payable no later than thirty (30) days before the event. Supplier costs are invoiced to you directly by each supplier unless we agree otherwise in writing."],
      ["Changes.", "You may change the guest count up to fourteen (14) days before the event. Changes to the date or venue are subject to availability and may incur additional fees and any supplier charges we cannot recover."],
      ["Cancellation by you.", "If you cancel more than ninety (90) days before the event, we will retain the deposit. If you cancel within ninety (90) days of the event, the full fee is payable. We recommend that you take out event insurance."],
      ["Cancellation by us.", "If we are unable to deliver the event for reasons within our control, we will refund all sums paid to us. We are not liable for events beyond our reasonable control, such as severe weather, venue closure or travel disruption, but we will work with you to rearrange the event where possible."],
      ["Suppliers.", "We recommend suppliers in good faith but each supplier contracts with you on its own terms and is responsible for its own goods and services. We will check that recommended suppliers hold appropriate public liability insurance."],
      ["Liability.", "Our total liability to you is limited to the fee paid to us under this contract. Nothing in this contract limits liability for death or personal injury caused by negligence, for fraud, or for anything that cannot be limited by law."],
      ["Your information.", "We use the personal information you give us only to plan your event and to contact you about it, in line with our privacy notice. We share it with suppliers only as needed for your event."],
      ["Law.", "This contract is governed by the law of England and Wales and the courts of England and Wales have exclusive jurisdiction."],
    ];
    terms.forEach(([h, b], i) => w.para(b, { lead: `${i + 1}. ${h}` }));
    w.advance(10);
    w.ensure(170);
    w.para("Please sign below to confirm your booking. A copy of the signed contract will be sent to you by email.");
    w.advance(14);
    let base = w.y + 10;
    const sigRow = (role, suffix, note, sameLineDate) => {
      w.text("Signed", w.m, base);
      const end = w.dots(w.m + 42, base, 200, { type: "signature", role, note: `${note} Signed` });
      w.text(suffix, end + 4, base);
      let dx = w.m + 392;
      if (!sameLineDate) {
        base += 28;
        dx = w.m;
      }
      w.text("Date", dx, base);
      w.dots(dx + 26, base, sameLineDate ? w.W - w.m - dx - 26 : 120, { type: "date", role, note: `${note} Date` });
    };
    sigRow("client", "(Client)", "Client", true);
    base += 28;
    w.text("Print name", w.m, base);
    w.dots(w.m + 56, base, 186, { type: "name", role: "client", note: "Client Print name" });
    base += 38;
    sigRow("firm", "(for and on behalf of Fakefield Events Ltd)", "Firm", false);
    w.y = base + 20;
  },
);

// ================================================================= 07  tutoring enrollment: parent signs, checkboxes, leading initials blank
await pdfFixture(
  "07-brightpath-tutoring-enrollment",
  {
    firmName: "Brightpath Fake Tutoring LLC",
    description:
      "Tutoring enrollment agreement, Helvetica 11, Letter, 2 pages. Client = parent/guardian. Student information (label item + separate underscore item): 'Student name', 'Grade', 'Parent/Guardian email'. Session package = 3 drawn checkbox squares. Leading initials blank '_______ I have read and agree to the cancellation and refund policy.' Signature: 'Parent/Guardian Signature: ____  Date: ____' (label and underscores separate items), 'Parent/Guardian Printed Name: ____'; firm: 'Approved by (Program Director): ____  Date: ____'.",
    pageRange: [1, 3],
    note: "Student fields are filled by the parent at signing or prefilled from the enrolment file.",
  },
  { font: "Helvetica", fontSize: 11, pageSize: LETTER, margin: 66, leading: 1.36, paraAfter: 7 },
  (w) => {
    w.title("Brightpath Tutoring", 18, 0);
    w.title("STUDENT ENROLLMENT AGREEMENT", 12, 12);
    w.para(
      'This Enrollment Agreement is between Brightpath Fake Tutoring LLC ("Brightpath") and the parent or legal guardian who signs below ("Parent"), on behalf of the student named below ("Student").',
    );
    w.heading("Student information", { size: 11.5 });
    const row = (label, type, x, wd, extra = {}) => {
      const base = w.y + 11;
      w.text(label, w.m, base);
      w.blank(w.m + x, base, wd, { type, role: "client", acceptRoles: ["prefill"], note: label, ...extra });
      w.y += 24;
    };
    row("Student name:", "text", 150, 260, { acceptTypes: ["name"] });
    row("Grade (2026-27):", "text", 150, 80);
    row("Parent/Guardian email:", "email", 150, 260);
    w.advance(4);
    w.heading("Session package (check one)", { size: 11.5 });
    for (const t of ["8 sessions - $480", "16 sessions - $920", "24 sessions - $1,320"]) {
      const top = w.y + 1;
      w.square(w.m + 14, top, 10, { role: "client", note: t });
      w.text(t, w.m + 32, top + 9);
      w.y += 22;
    }
    w.advance(6);
    const terms = [
      ["Sessions.", "Each session is sixty (60) minutes, one-to-one, in person at a Brightpath center or online. Sessions are scheduled through the parent portal. Package sessions must be used within six (6) months of the first session."],
      ["Payment.", "The package price is due before the first session. Brightpath does not charge enrollment or materials fees for the packages above."],
      ["Cancellation and refunds.", "Sessions cancelled with at least twenty-four (24) hours' notice may be rescheduled. Sessions cancelled with less notice, or missed, are counted as used. Unused sessions are refundable at the per-session rate, less a twenty-five dollar ($25) processing fee, if Parent withdraws within thirty (30) days of enrollment."],
      ["Progress and communication.", "Brightpath will send Parent a short written progress note after every fourth session and will meet with Parent on request. Tutors do not complete graded schoolwork on Student's behalf."],
      ["Safety.", "All tutors complete a background check before working with students. Online sessions take place on a recorded platform; recordings are kept for thirty (30) days for safety and quality review and then deleted."],
      ["Liability.", "Brightpath does not guarantee any particular grade, test score or admission outcome. Brightpath's total liability under this Agreement is limited to the amount Parent paid for the current package."],
    ];
    terms.forEach(([h, b], i) => w.para(b, { lead: `${i + 1}. ${h}` }));
    w.advance(4);
    {
      w.ensure(40);
      const base = w.y + 11;
      const end = w.blank(w.m, base, 60, { type: "initials", role: "client", note: "leading initials (refund policy)" });
      w.text("I have read and agree to the cancellation and refund policy above.", end + 8, base);
      w.y += 30;
    }
    w.ensure(220);
    w.heading("Signatures", { size: 11.5 });
    w.para("By signing, Parent agrees to this Enrollment Agreement on behalf of Parent and Student.");
    w.advance(14);
    let base = w.y + 11;
    const l1 = "Parent/Guardian Signature:";
    w.text(l1, w.m, base);
    let x = w.m + w.wid(l1 + " ");
    w.blank(x, base, 190, { type: "signature", role: "client", note: "Parent/Guardian Signature" });
    w.text("Date:", w.m + 380, base);
    w.blank(w.m + 380 + w.wid("Date: "), base, w.W - w.m - (w.m + 380 + w.wid("Date: ")), { type: "date", role: "client", note: "Parent Date" });
    base += 32;
    const l2 = "Parent/Guardian Printed Name:";
    w.text(l2, w.m, base);
    w.blank(w.m + w.wid(l2 + " "), base, 170, { type: "name", role: "client", note: "Parent/Guardian Printed Name" });
    base += 48;
    const l3 = "Approved by (Program Director):";
    w.text(l3, w.m, base);
    x = w.m + w.wid(l3 + " ");
    w.blank(x, base, 150, { type: "signature", role: "firm", note: "Program Director approval" });
    w.text("Date:", w.m + 380, base);
    w.blank(w.m + 380 + w.wid("Date: "), base, w.W - w.m - (w.m + 380 + w.wid("Date: ")), { type: "date", role: "firm", note: "Director Date" });
    w.y = base + 20;
  },
);

// ================================================================= 08  freelance software development, A4 Times, columns with captions under underscores
await pdfFixture(
  "08-quillfeather-freelance-dev",
  {
    firmName: "Quillfeather Code Studio LLC",
    description:
      "Freelance software development contract, TimesRoman 10.5, A4, 2-3 pages. Quillfeather Code Studio LLC (\"Developer\") and \"Client\". Milestone list with 'due ____' and '$____' blanks. Signature: two columns headed 'DEVELOPER' | 'CLIENT' (defined terms only, firm legal name not in the heading); each field is a bare underscore line with a caption underneath ('Signature', 'Printed name', 'Date'); client column adds 'Company (if any)'.",
    pageRange: [2, 4],
  },
  { font: "TimesRoman", fontSize: 10.5, pageSize: A4, margin: 64, leading: 1.38, paraAfter: 6, footer: (w, i, n) => w.text(`${i + 1} / ${n}`, w.W / 2 - 8, w.H - 34, { size: 9 }) },
  (w) => {
    w.title("SOFTWARE DEVELOPMENT CONTRACT", 14, 10);
    w.para(
      'This Software Development Contract (the "Contract") is made between Quillfeather Code Studio LLC, an independent software studio ("Developer"), and the person or company signing below as client ("Client"). Developer will design and build the web application described in the attached project brief (the "Software").',
    );
    w.heading("1. Milestones and payment", { size: 11 });
    w.para("Client will pay Developer a fixed fee for each milestone on Client's written acceptance of that milestone:");
    const pf = (type, note) => ({ type, role: "prefill", acceptRoles: ["client"], note });
    for (const [k, name] of [
      [1, "Clickable prototype and technical design"],
      [2, "Production release, documentation and handover"],
    ]) {
      w.para([
        `Milestone ${k}: ${name}, due `,
        { blank: 80, field: pf("date", `M${k} due date`) },
        ", fee $",
        { blank: 60, field: pf("text", `M${k} fee`) },
        ".",
      ], { indent: 18, after: 4 });
    }
    w.advance(4);
    const secs = [
      ["2. Acceptance", "Client will test each milestone within ten (10) business days after delivery and either accept it in writing or send a list of specific defects. Developer will fix reported defects that are within the agreed scope at no additional charge. A milestone is accepted if Client does not respond within the test period or uses it in production."],
      ["3. Changes", "Requests outside the project brief are change requests. Developer will estimate the time and cost of each change request, and will start work on it only after Client approves the estimate in writing. Approved changes are billed at Developer's hourly rate in the project brief."],
      ["4. Client materials", "Client will provide content, credentials, design assets and feedback promptly. Client confirms it has the right to provide these materials and that their use in the Software will not infringe anyone else's rights."],
      ["5. Ownership and licence", "When Client has paid all fees, Developer assigns to Client the copyright in the custom code written for the Software. Developer keeps ownership of its pre-existing libraries, tools and general know-how, and grants Client a perpetual, non-exclusive licence to use them as part of the Software. Open-source components remain under their own licences."],
      ["6. Warranty", "For sixty (60) days after final acceptance, Developer will fix any defect that causes the Software not to work materially as described in the project brief. This warranty does not cover changes made by anyone other than Developer, third-party services, or hosting environments Developer did not configure."],
      ["7. Confidentiality", "Each party will keep confidential the other party's non-public business and technical information received under this Contract, and will use it only for the project. Developer may show the Software in its portfolio only with Client's written consent."],
      ["8. Liability", "Neither party is liable for indirect or consequential loss, or for loss of profit, data or goodwill. Developer's total liability under this Contract is limited to the fees paid to Developer under it."],
      ["9. Termination", "Either party may end this Contract by written notice if the other party materially breaches it and does not fix the breach within fourteen (14) days. If Client ends the Contract for convenience, Client will pay for all completed milestones and for work in progress at the hourly rate."],
      ["10. General", "Developer is an independent contractor and is responsible for its own taxes. This Contract and the project brief are the entire agreement between the parties. Changes must be in writing. This Contract is governed by the laws of the State of Oregon."],
    ];
    for (const [h, b] of secs) {
      w.heading(h, { size: 11 });
      w.para(b);
    }
    w.advance(12);
    w.ensure(260);
    w.para("Signed by the parties on the dates written below.", { font: w.ital });
    w.advance(10);
    const gap = 40;
    const colW = (w.textW - gap) / 2;
    const xs = [w.m, w.m + colW + gap];
    let base = w.y + 11;
    w.text("DEVELOPER", xs[0], base, { font: w.bold });
    w.text("CLIENT", xs[1], base, { font: w.bold });
    const rows = [
      ["Signature", "signature", 44],
      ["Printed name", "name", 38],
      ["Date", "date", 38],
    ];
    for (const [cap, type, step] of rows) {
      base += step;
      [
        ["firm", "DEVELOPER"],
        ["client", "CLIENT"],
      ].forEach(([role, head], k) => {
        w.blank(xs[k], base, colW - 20, { type, role, note: `${head} / ${cap}` });
        w.text(cap, xs[k], base + 12, { size: 9, font: w.ital });
      });
    }
    base += 38;
    w.blank(xs[1], base, colW - 20, { type: "company", role: "client", acceptRoles: ["prefill"], acceptTypes: ["name"], note: "CLIENT / Company (if any)" });
    w.text("Company (if any)", xs[1], base + 12, { size: 9, font: w.ital });
    w.y = base + 24;
  },
);

console.log(`wrote ${written.length} PDFs to ${path.relative(ROOT, OUT)}/`);
for (const s of written) console.log("  " + s);
