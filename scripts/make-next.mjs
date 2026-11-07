#!/usr/bin/env node
// NEXT test set for the field detector: 8 FAKE client agreements + ground truth, written without
// looking at the detector, its tests or the earlier fixture sets (only the header comment of
// scripts/make-final.mjs, for the conventions below). Its first run is the honest unseen-document score.
//
//   node scripts/make-next.mjs && FIXTURE_DIR=fixtures/next npx vitest run test/detect.test.ts
//
// All firms, people, emails and addresses are invented (example.com / example.test).
// Coordinates: PDF points, top-left origin. A field box is the area a person writes in: its bottom sits
// on the blank (underscore baseline + 2pt, or the drawn rule / dotted leader); signature 24pt tall,
// initials 18pt, checkbox = square + 1pt each side, everything else 14pt.
// Roles: fields in a party's signature block belong to that party ("client" / "firm"); blanks in the
// header or order form that the firm fills from the file (client name, file reference, date sent) are
// "prefill".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, PageSizes, rgb } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures", "next");
fs.mkdirSync(OUT, { recursive: true });

const LETTER = PageSizes.Letter;
const A4 = PageSizes.A4;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.4, 0.4, 0.4);
const FIXED_DATE = new Date("2026-11-01T12:00:00Z");
const r1 = (v) => Math.round(v * 10) / 10;
const H_OF = { signature: 24, initials: 18 };
const fh = (t) => H_OF[t] ?? 14;

const FAMILIES = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique],
};

// ---------------------------------------------------------------- tiny layout engine
class Doc {
  static async create(o = {}) {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(FIXED_DATE);
    pdf.setModificationDate(FIXED_DATE);
    pdf.setProducer("make-next.mjs");
    pdf.setCreator("make-next.mjs");
    const [r, b, i] = FAMILIES[o.family ?? "Helvetica"];
    const fonts = { r: await pdf.embedFont(r), b: await pdf.embedFont(b), i: await pdf.embedFont(i) };
    return new Doc(pdf, fonts, o);
  }
  constructor(pdf, fonts, o) {
    this.pdf = pdf;
    this.f = fonts;
    this.size = o.size ?? LETTER;
    this.fs = o.fontSize ?? 10;
    this.lead = o.leading ?? 1.4;
    this.m = o.margin ?? 72;
    this.footer = o.footer; // (doc, pageIndex, pageCount) => void
    this.firmName = o.firmName; // legal name of the firm (the workspace owner) as it appears in the document
    this.fields = [];
    this.pages = [];
    this.n = 0;
    this.newPage();
  }
  get W() { return this.size[0]; }
  get H() { return this.size[1]; }
  get right() { return this.W - this.m; }
  newPage() {
    this.page = this.pdf.addPage(this.size);
    this.pages.push(this.page);
    this.y = this.m; // top of the next line (top-left coordinates)
  }
  ensure(h) {
    if (this.y + h > this.H - this.m - 20) this.newPage();
  }
  get pi() { return this.pages.length - 1; }
  tw(s, font = this.f.r, size = this.fs) { return font.widthOfTextAtSize(s, size); }
  // draw text with its baseline at top-left y
  text(s, x, base, o = {}) {
    const font = o.font ?? this.f.r;
    const size = o.size ?? this.fs;
    (o.page ?? this.page).drawText(s, { x, y: this.H - base, size, font, color: o.color ?? BLACK });
    return x + this.tw(s, font, size);
  }
  field(type, role, x, bottom, w, label, extra = {}) {
    const h = fh(type);
    this.n += 1;
    this.fields.push({
      id: `f${this.n}`, type, role, page: extra.page ?? this.pi,
      x: r1(x), y: r1(bottom - h), w: r1(w), h, label, required: extra.required ?? type !== "checkbox",
    });
  }
  gap(h) { this.y += h; }
  wrap(s, width, font, size) {
    const out = [];
    let line = "";
    for (const w of s.split(/\s+/)) {
      const t = line ? line + " " + w : w;
      if (this.tw(t, font, size) > width && line) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line);
    return out;
  }
  p(s, o = {}) {
    const font = o.bold ? this.f.b : o.italic ? this.f.i : this.f.r;
    const size = o.size ?? this.fs;
    const x = o.x ?? this.m;
    const width = (o.width ?? this.right - x);
    const lh = size * this.lead;
    for (const ln of this.wrap(s, width, font, size)) {
      this.ensure(lh);
      const lw = this.tw(ln, font, size);
      const lx = o.center ? (this.W - lw) / 2 : x;
      this.text(ln, lx, this.y + size, { font, size, color: o.color });
      this.y += lh;
    }
    this.y += o.after ?? size * 0.6;
  }
  h(s, size = this.fs + 2, o = {}) { this.ensure(size * 3); this.gap(size * 0.4); this.p(s, { bold: true, size, ...o }); }
  // One line made of text pieces and blanks. Blank: { u: width } (underscores), { rule: width },
  // { dots: width }; any blank may carry f: [type, role, label]. Returns the baseline used.
  row(parts, o = {}) {
    const size = o.size ?? this.fs;
    const lh = Math.max(size * this.lead, o.minH ?? 0);
    this.ensure(lh + 14);
    const base = this.y + (o.pre ?? 14) + size; // room above for handwriting
    let x = o.x ?? this.m;
    for (const part of parts) {
      if (typeof part === "string") { x = this.text(part, x, base, { size, font: o.bold ? this.f.b : this.f.r }); continue; }
      if (part.at !== undefined) { x = part.at; continue; }
      let w;
      let bottom;
      if (part.u !== undefined) {
        const uw = this.tw("_", this.f.r, size);
        const n = Math.max(1, Math.round(part.u / uw));
        w = n * uw;
        this.text("_".repeat(n), x, base, { size });
        bottom = base + 2;
      } else if (part.dots !== undefined) {
        const dw = this.tw(".", this.f.r, size);
        const n = Math.max(1, Math.round(part.dots / dw));
        w = n * dw;
        this.text(".".repeat(n), x, base, { size });
        bottom = base + 1;
      } else if (part.rule !== undefined) {
        w = part.rule;
        this.page.drawLine({ start: { x, y: this.H - (base + 2) }, end: { x: x + w, y: this.H - (base + 2) }, thickness: 0.75, color: BLACK });
        bottom = base + 2;
      }
      if (part.f) this.field(part.f[0], part.f[1], x, bottom, w, part.f[2]);
      x += w + (part.sp ?? 0);
    }
    this.y = base + (o.after ?? size * 0.5);
    return base;
  }
  // checkbox square (side s) at the start of a wrapped paragraph
  check(label, role, s = 8, o = {}) {
    const size = this.fs;
    const x = o.x ?? this.m;
    const lines = this.wrap(label, this.right - x - s - 8, this.f.r, size);
    this.ensure(lines.length * size * this.lead + 6);
    const base = this.y + size;
    const top = base - s + 0.5;
    this.page.drawRectangle({ x, y: this.H - (top + s), width: s, height: s, borderColor: BLACK, borderWidth: 0.75 });
    this.n += 1;
    this.fields.push({ id: `f${this.n}`, type: "checkbox", role, page: this.pi, x: r1(x - 1), y: r1(top - 1), w: s + 2, h: s + 2, label: o.name ?? label.slice(0, 60), required: false });
    let b = base;
    for (const ln of lines) { this.text(ln, x + s + 8, b); b += size * this.lead; }
    this.y = b - size * this.lead + size * 0.9;
  }
  async save(name) {
    if (this.footer) this.pages.forEach((pg, i) => this.footer(this, pg, i, this.pages.length));
    const bytes = await this.pdf.save({ useObjectStreams: false });
    fs.writeFileSync(path.join(OUT, name + ".pdf"), bytes);
    const fields = this.fields.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    fs.writeFileSync(path.join(OUT, name + ".expected.json"), JSON.stringify({ firmName: this.firmName, fields }, null, 2) + "\n");
    console.log(`${name}: ${this.pages.length} page(s), ${fields.length} field(s)`);
  }
}

const filler = (topic) => [
  `This agreement sets out the terms on which we will provide ${topic} to you. Please read it carefully; it is a binding contract once both parties have signed.`,
  "Each party will keep the other party's confidential information confidential, use it only for the purpose of this agreement, and return or destroy it on request, except where the law requires otherwise.",
  "Our liability for any claim arising from this agreement is limited to the fees paid in the twelve months before the claim, except for fraud or any liability that cannot lawfully be limited.",
  "Either party may end this agreement by giving thirty days' written notice. Fees for work done up to the end date remain payable.",
];

// ---------------------------------------------------------------- 01: accounting engagement letter
// Letter, Times, letter-style; stacked signature blocks with labelled underscore lines, firm first.
async function doc01() {
  const d = await Doc.create({ family: "Times", fontSize: 11, firmName: "Ledgerwick & Pole Chartered Accountants" });
  d.p("Ledgerwick & Pole Chartered Accountants", { bold: true, size: 14 });
  d.p("12 Example Lane, Sampletown ZZ9 9ZZ  ·  hello@ledgerwick.example.com", { color: GREY, size: 9, after: 18 });
  d.row(["Date: ", { u: 120, f: ["date", "prefill", "Date sent"] }]);
  d.row(["Our ref: ", { u: 110, f: ["text", "prefill", "File reference"] }]);
  d.row(["Dear ", { u: 180, f: ["name", "prefill", "Client name"] }, ","], { after: 14 });
  d.h("Engagement letter: annual accounts and tax return", 12);
  for (const s of filler("bookkeeping review, annual accounts and personal tax return preparation")) d.p(s);
  d.h("1. Our responsibilities", 11);
  d.p("We will prepare your accounts from the records and explanations you give us. We will not audit them. We will tell you about any matter that comes to our attention which we think you should know about.");
  d.h("2. Your responsibilities", 11);
  d.p("You are responsible for keeping proper records and for giving us complete and accurate information on time. You remain legally responsible for your tax return even though we prepare it.");
  d.h("3. Fees", 11);
  d.p("Our fee for the work described is a fixed fee as set out in the schedule, payable within fourteen days of our invoice. Additional work will be agreed with you in writing before it starts.");
  for (const s of filler("the services").slice(1)) d.p(s);
  d.gap(10);
  d.p("Signed for and on behalf of Ledgerwick & Pole", { bold: true });
  d.row(["Signature: ", { u: 200, f: ["signature", "firm", "Firm signature"] }]);
  d.row(["Name: ", { u: 200, f: ["name", "firm", "Firm signatory name"] }]);
  d.row(["Position: ", { u: 200, f: ["title", "firm", "Firm signatory position"] }]);
  d.row(["Date: ", { u: 140, f: ["date", "firm", "Firm date"] }], { after: 20 });
  d.p("I confirm that I have read and understood this letter and agree to its terms.", { bold: true });
  d.row(["Signature: ", { u: 200, f: ["signature", "client", "Client signature"] }]);
  d.row(["Print name: ", { u: 200, f: ["name", "client", "Client name"] }]);
  d.row(["Date: ", { u: 140, f: ["date", "client", "Client date"] }]);
  await d.save("01-ledgerwick-accounting-letter");
}

// ---------------------------------------------------------------- 02: law firm retainer, A4
// Two-column signature table with drawn rules and captions UNDER the lines; client left, firm right.
async function doc02() {
  const d = await Doc.create({ size: A4, fontSize: 10, margin: 64, firmName: "Fenworth Oakes Solicitors" });
  d.p("FENWORTH OAKES SOLICITORS", { bold: true, size: 15, center: true });
  d.p("Client care letter and terms of business", { center: true, size: 11, after: 16 });
  d.row(["Client: ", { u: 190, f: ["name", "prefill", "Client name"] }, "   Matter no.: ", { u: 100, f: ["text", "prefill", "Matter number"] }]);
  d.gap(8);
  const paras = [
    ...filler("legal advice and representation in the matter described above"),
    "Responsibility for your matter. Your matter will be handled by the solicitor named in our covering letter, supervised by a partner. If you are unhappy with our service, please raise it with the supervising partner first.",
    "Money on account. We may ask you for money on account of costs and disbursements. We hold it in our client account and will account to you for interest in line with our interest policy.",
    "Storage of papers. We will keep your file for at least six years after the matter ends, after which it may be destroyed without further reference to you.",
    "Anti-money-laundering checks. We are required to verify your identity before we act and may use an electronic identity check provider for this purpose.",
  ];
  d.h("Terms of business", 11);
  paras.forEach((s, i) => d.p(`${i + 1}. ${s}`));
  for (const s of filler("these services")) d.p(s);
  d.gap(6);
  d.h("Acceptance", 11);
  d.p("Please sign below to confirm that you accept these terms. We will countersign and return a copy for your records.");
  d.ensure(160);
  d.gap(8);
  const colW = (d.right - d.m - 30) / 2;
  const lx = d.m, rx = d.m + colW + 30;
  d.text("CLIENT", lx, d.y + 10, { font: d.f.b });
  d.text("FOR FENWORTH OAKES SOLICITORS", rx, d.y + 10, { font: d.f.b });
  d.y += 14;
  const rows = [["signature", "Signature"], ["name", "Full name"], ["date", "Date"]];
  for (const [t, cap] of rows) {
    const bottom = d.y + (t === "signature" ? 32 : 22);
    for (const [x, role] of [[lx, "client"], [rx, "firm"]]) {
      d.page.drawLine({ start: { x, y: d.H - bottom }, end: { x: x + colW, y: d.H - bottom }, thickness: 0.75, color: BLACK });
      d.text(cap, x, bottom + 10, { size: 8, color: GREY });
      d.field(t, role, x, bottom, colW, `${role} ${cap}`);
    }
    d.y = bottom + 14;
  }
  await d.save("02-fenworth-solicitors-a4-captions-under");
}

// ---------------------------------------------------------------- 03: architecture services
// Client initials in the footer of every page, option checkboxes, signature at the end.
async function doc03() {
  const d = await Doc.create({
    fontSize: 10,
    firmName: "Plinth Studio Architects",
    footer: (doc, pg, i, n) => {
      const base = doc.H - 40;
      const lab = "Client initials: ";
      const x0 = doc.right - 120;
      doc.text(`Page ${i + 1} of ${n}`, doc.m, base, { page: pg, size: 8, color: GREY });
      const x1 = doc.text(lab, x0, base, { page: pg, size: 8 });
      const uw = doc.tw("_", doc.f.r, 8);
      const k = Math.round(50 / uw);
      doc.text("_".repeat(k), x1, base, { page: pg, size: 8 });
      doc.field("initials", "client", x1, base + 2, k * uw, `Client initials p${i + 1}`, { page: i });
    },
  });
  d.p("Plinth Studio Architects", { bold: true, size: 16 });
  d.p("Appointment of architect for a domestic project", { size: 11, after: 14 });
  d.row(["Client name ", { u: 210, f: ["name", "prefill", "Client name"] }]);
  d.row(["Project address ", { u: 260, f: ["text", "prefill", "Project address"] }]);
  d.row(["Reference ", { u: 120, f: ["text", "prefill", "File reference"] }], { after: 12 });
  d.h("Scope of services");
  d.p("Tick each stage you are appointing us for. Stages not ticked are excluded from this appointment and may be added later by written agreement.");
  d.check("Stage 1: Brief and feasibility study", "client", 8, { name: "Stage 1" });
  d.check("Stage 2: Concept design, including two design options and one round of revisions", "client", 8, { name: "Stage 2" });
  d.check("Stage 3: Planning application drawings and submission", "client", 8, { name: "Stage 3" });
  d.check("Stage 4: Technical design and building regulations package", "client", 8, { name: "Stage 4" });
  d.check("Stage 5: Contract administration during construction", "client", 8, { name: "Stage 5" });
  d.gap(6);
  for (let k = 0; k < 2; k++) for (const s of filler("architectural services")) d.p(s);
  d.h("Copyright");
  d.p("We keep the copyright in the drawings and documents we prepare. You have a licence to use them for the project once our fees are paid.");
  d.h("Insurance");
  d.p("We hold professional indemnity insurance of at least the amount required by our professional body, and will keep it in place for six years after the services end.");
  d.h("Signatures");
  d.row(["Signed by the client ", { u: 220, f: ["signature", "client", "Client signature"] }]);
  d.row(["Date ", { u: 120, f: ["date", "client", "Client date"] }]);
  d.gap(10);
  d.row(["Signed for Plinth Studio ", { u: 220, f: ["signature", "firm", "Firm signature"] }]);
  d.row(["Date ", { u: 120, f: ["date", "firm", "Firm date"] }]);
  await d.save("03-plinth-architects-initials-checkboxes");
}

// ---------------------------------------------------------------- 04: marketing SOW with order-form grid
// A ruled table at the top whose value cells are the blanks (no underscores), then an acceptance block
// in a ruled table with label cells on the left.
async function doc04() {
  const d = await Doc.create({ fontSize: 9.5, margin: 54, firmName: "Brassfinch Marketing Co." });
  d.p("BRASSFINCH MARKETING CO.", { bold: true, size: 14 });
  d.p("Statement of Work / Order Form", { size: 11, after: 10 });
  const tableX = d.m, labW = 140, valW = d.right - d.m - 140;
  const cell = (label, f, rowH = 22) => {
    const top = d.y;
    const bottom = top + rowH;
    d.page.drawRectangle({ x: tableX, y: d.H - bottom, width: labW, height: rowH, borderColor: BLACK, borderWidth: 0.5, color: rgb(0.93, 0.93, 0.93) });
    d.page.drawRectangle({ x: tableX + labW, y: d.H - bottom, width: valW, height: rowH, borderColor: BLACK, borderWidth: 0.5 });
    d.text(label, tableX + 5, top + rowH / 2 + 3.5, { font: d.f.b, size: 9 });
    if (f) d.field(f[0], f[1], tableX + labW + 4, bottom - 4, valW - 8, f[2]);
    d.y = bottom;
  };
  cell("Customer legal name", ["company", "prefill", "Customer company"]);
  cell("Customer contact", ["name", "prefill", "Customer contact name"]);
  cell("Contact email", ["email", "prefill", "Customer email"]);
  cell("Order reference", ["text", "prefill", "Order reference"]);
  cell("Start date", ["date", "prefill", "Start date"]);
  d.gap(14);
  d.h("Services", 10.5);
  d.p("Brand audit, quarterly campaign plan, paid social management for two channels, and monthly performance reporting, as described in Annex A.");
  d.h("Fees and payment", 10.5);
  d.p("A monthly retainer as stated in Annex B, invoiced in advance and payable within thirty days. Media spend is passed through at cost and invoiced monthly in arrears.");
  for (const s of filler("marketing services")) d.p(s);
  d.h("Acceptance", 10.5);
  d.p("By signing, each party agrees to this Order Form and the Brassfinch Standard Terms, which form part of it.");
  d.gap(4);
  d.ensure(200);
  const half = (d.right - d.m) / 2;
  const block = (x, title, role) => {
    let y = d.y;
    d.text(title, x, y + 10, { font: d.f.b });
    y += 16;
    for (const [lab, t, rh] of [["Signature", "signature", 34], ["Name", "name", 22], ["Title", "title", 22], ["Date", "date", 22]]) {
      d.page.drawRectangle({ x, y: d.H - (y + rh), width: 70, height: rh, borderColor: BLACK, borderWidth: 0.5 });
      d.page.drawRectangle({ x: x + 70, y: d.H - (y + rh), width: half - 80, height: rh, borderColor: BLACK, borderWidth: 0.5 });
      d.text(lab, x + 5, y + rh / 2 + 3.5, { size: 9 });
      d.field(t, role, x + 74, y + rh - 4, half - 88, `${role} ${lab}`);
      y += rh;
    }
    return y;
  };
  block(d.m, "Customer", "client");
  d.y = block(d.m + half, "Brassfinch Marketing Co.", "firm") + 10;
  await d.save("04-brassfinch-marketing-order-grid");
}

// ---------------------------------------------------------------- 05: financial advisory
// Consent checkboxes, client email field, corporate "By: / Its:" signature blocks side by side.
async function doc05() {
  const d = await Doc.create({ fontSize: 10, margin: 66, firmName: "Harrowgate Wealth Partners" });
  d.p("Harrowgate Wealth Partners", { bold: true, size: 15 });
  d.p("Investment advisory agreement", { size: 11, color: GREY, after: 16 });
  d.p("This agreement is between Harrowgate Wealth Partners (\"the Adviser\") and the client named in the signature block below (\"the Client\").");
  d.h("1. Services");
  d.p("The Adviser will review the Client's financial position and objectives, recommend an investment strategy, and review it at least once a year.");
  d.h("2. Fees");
  d.p("An annual advisory fee charged quarterly in arrears as a percentage of assets under advice, as shown in the fee schedule. No commission is taken from product providers.");
  for (const s of filler("investment advice")) d.p(s);
  d.h("3. Client consents");
  d.p("Please tick to confirm:");
  d.check("I have received and read the Adviser's privacy notice.", "client", 9, { name: "Privacy notice" });
  d.check("I agree to receive statements and notices by email at the address below.", "client", 9, { name: "Email consent" });
  d.check("I confirm that the information I have given about my circumstances is complete and accurate.", "client", 9, { name: "Accuracy" });
  d.gap(6);
  d.row(["Email address for notices: ", { u: 230, f: ["email", "client", "Client email"] }], { after: 18 });
  d.ensure(170);
  d.h("4. Signatures");
  const top = d.y;
  const colX = [d.m, d.m + 250];
  const blocks = [
    ["CLIENT", "client", [["By: ", "signature", 170], ["Name: ", "name", 160], ["Date: ", "date", 160]]],
    ["HARROWGATE WEALTH PARTNERS", "firm", [["By: ", "signature", 170], ["Name: ", "name", 160], ["Its: ", "title", 168], ["Date: ", "date", 160]]],
  ];
  let maxY = top;
  blocks.forEach(([title, role, rows], k) => {
    d.y = top;
    d.text(title, colX[k], d.y + 10, { font: d.f.b, size: 9 });
    d.y += 16;
    for (const [lab, t, w] of rows) d.row([lab, { u: w, f: [t, role, `${role} ${lab.trim()}`] }], { x: colX[k], pre: t === "signature" ? 20 : 14 });
    maxY = Math.max(maxY, d.y);
  });
  d.y = maxY;
  await d.save("05-harrowgate-advisory-consents-by-its");
}

// ---------------------------------------------------------------- 06: translation services
// Side-by-side signature lines on the SAME text line, captions on the line below ("Client" /
// "For Lintwhistle Translation Services").
async function doc06() {
  const d = await Doc.create({ fontSize: 10.5, margin: 72, firmName: "Lintwhistle Translation Services" });
  d.p("Lintwhistle Translation Services", { bold: true, size: 14, center: true });
  d.p("Agreement for translation and interpreting services", { center: true, after: 16 });
  d.row(["Client: ", { u: 200, f: ["name", "prefill", "Client name"] }], { pre: 0 });
  d.row(["Job reference: ", { u: 120, f: ["text", "prefill", "Job reference"] }], { after: 12 });
  d.h("Scope", 11);
  d.p("Translation of the documents listed in the quotation from the source language into the target language, with one round of client review, and interpreting at the sessions booked through our portal.");
  d.h("Turnaround and quality", 11);
  d.p("We will deliver by the dates in the quotation. Each translation is checked by a second linguist. Certified translations carry our statement of accuracy.");
  d.h("Cancellation", 11);
  d.p("Interpreting sessions cancelled less than forty-eight hours before the start are charged in full. Translation work cancelled part-way is charged for the words completed.");
  for (const s of filler("translation and interpreting services")) d.p(s);
  d.gap(30);
  d.ensure(80);
  const base = d.y + 10.5;
  const uw = d.tw("_", d.f.r, 10.5);
  const n = Math.round(200 / uw);
  const x2 = d.right - n * uw;
  d.text("_".repeat(n), d.m, base);
  d.text("_".repeat(n), x2, base);
  d.field("signature", "client", d.m, base + 2, n * uw, "Client signature");
  d.field("signature", "firm", x2, base + 2, n * uw, "Translator signature");
  d.text("Client", d.m, base + 14, { size: 9 });
  d.text("For Lintwhistle Translation Services", x2, base + 14, { size: 9 });
  d.y = base + 40;
  const b2 = d.y + 10.5;
  const n2 = Math.round(120 / uw);
  d.text("_".repeat(n2), d.m, b2);
  d.text("_".repeat(n2), x2, b2);
  d.field("date", "client", d.m, b2 + 2, n2 * uw, "Client date");
  d.field("date", "firm", x2, b2 + 2, n2 * uw, "Firm date");
  d.text("Date", d.m, b2 + 14, { size: 9 });
  d.text("Date", x2, b2 + 14, { size: 9 });
  d.y = b2 + 30;
  await d.save("06-lintwhistle-translation-side-by-side");
}

// ---------------------------------------------------------------- 07: IT managed services, Courier
// Plain-text style contract with dotted leaders instead of underscores.
async function doc07() {
  const d = await Doc.create({ family: "Courier", fontSize: 9.5, margin: 60, leading: 1.3, firmName: "Crankshaw Networks Ltd" });
  d.p("CRANKSHAW NETWORKS LTD - MANAGED IT SERVICES AGREEMENT", { bold: true });
  d.p("=".repeat(56), { after: 10 });
  d.row(["Customer ......: ", { dots: 220, f: ["company", "prefill", "Customer company"] }], { pre: 6 });
  d.row(["Site address ..: ", { dots: 260, f: ["text", "prefill", "Site address"] }], { pre: 6 });
  d.row(["Agreement no. .: ", { dots: 120, f: ["text", "prefill", "Agreement number"] }], { pre: 6, after: 12 });
  const sections = [
    ["1. SERVICES", "Help desk support during business hours, remote monitoring of servers and network devices, patch management, and backup monitoring for the devices listed in the asset register."],
    ["2. SERVICE LEVELS", "Priority 1 incidents: response within one hour. Priority 2: four business hours. Priority 3: next business day. Service credits are the customer's only remedy for missed targets."],
    ["3. CUSTOMER DUTIES", "The customer will give reasonable remote and on-site access, keep licences current, and tell us promptly about changes to the environment."],
    ["4. CHARGES", "A monthly per-device charge, invoiced monthly in advance. Project work outside the services is quoted separately."],
    ["5. TERM", "Twelve months from the start date, then rolling monthly until ended by either party on ninety days' notice."],
  ];
  for (const [h, t] of sections) { d.p(h, { bold: true, after: 2 }); d.p(t); }
  for (const s of filler("managed IT services")) d.p(s);
  d.gap(8);
  d.ensure(130);
  d.p("SIGNED for and on behalf of the CUSTOMER", { bold: true, after: 0 });
  d.row(["Signature ...: ", { dots: 200, f: ["signature", "client", "Customer signature"] }]);
  d.row(["Name ........: ", { dots: 200, f: ["name", "client", "Customer name"] }], { pre: 8 });
  d.row(["Job title ...: ", { dots: 200, f: ["title", "client", "Customer title"] }], { pre: 8 });
  d.row(["Date ........: ", { dots: 110, f: ["date", "client", "Customer date"] }], { pre: 8, after: 18 });
  d.ensure(110);
  d.p("SIGNED for and on behalf of CRANKSHAW NETWORKS LTD", { bold: true, after: 0 });
  d.row(["Signature ...: ", { dots: 200, f: ["signature", "firm", "Firm signature"] }]);
  d.row(["Name ........: ", { dots: 200, f: ["name", "firm", "Firm name"] }], { pre: 8 });
  d.row(["Date ........: ", { dots: 110, f: ["date", "firm", "Firm date"] }], { pre: 8 });
  await d.save("07-crankshaw-it-courier-dotted");
}

// ---------------------------------------------------------------- 08: tutoring, one page
// Parent/guardian as the client, "Signed ____ Dated ____" on one line, contact text fields, firm block last.
async function doc08() {
  const d = await Doc.create({ fontSize: 10, margin: 60, firmName: "Owlcroft Tutoring" });
  d.p("Owlcroft Tutoring", { bold: true, size: 16 });
  d.p("Tuition agreement", { size: 11, after: 12 });
  d.row(["Student name: ", { u: 170, f: ["name", "prefill", "Student name"] }, "  Year group: ", { u: 60, f: ["text", "prefill", "Year group"] }]);
  d.gap(4);
  d.p("Owlcroft Tutoring will provide one-to-one tuition sessions at the times agreed with the parent or guardian. Sessions are sixty minutes long and take place online or at the address below.");
  d.p("Sessions cancelled with less than twenty-four hours' notice are charged in full. Fees are payable monthly in advance by bank transfer.");
  d.p("We keep session notes and progress reports for the duration of tuition and for one year afterwards, and share them only with the parent or guardian.");
  d.h("Contact details", 11);
  d.row(["Parent/guardian phone: ", { u: 150, f: ["text", "client", "Guardian phone"] }]);
  d.row(["Parent/guardian email: ", { u: 210, f: ["email", "client", "Guardian email"] }]);
  d.row(["Emergency contact: ", { u: 230, f: ["text", "client", "Emergency contact"] }], { after: 10 });
  d.h("Agreement", 11);
  d.p("I am the parent or guardian of the student named above and I agree to these terms on their behalf.");
  d.row(["Signed ", { u: 190, f: ["signature", "client", "Guardian signature"] }, "   Dated ", { u: 100, f: ["date", "client", "Guardian date"] }]);
  d.row(["Print name ", { u: 190, f: ["name", "client", "Guardian name"] }], { after: 18 });
  d.p("For Owlcroft Tutoring", { italic: true, after: 0 });
  d.row(["Signed ", { u: 190, f: ["signature", "firm", "Tutor signature"] }, "   Dated ", { u: 100, f: ["date", "firm", "Tutor date"] }]);
  await d.save("08-owlcroft-tutoring-one-line");
}

for (const f of fs.readdirSync(OUT)) if (/\.(pdf|expected\.json)$/.test(f)) fs.rmSync(path.join(OUT, f));
for (const make of [doc01, doc02, doc03, doc04, doc05, doc06, doc07, doc08]) await make();
