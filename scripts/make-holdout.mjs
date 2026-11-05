#!/usr/bin/env node
// HELD-OUT corpus for the field detector: fake agreements in industries the tuning corpus
// (scripts/make-fixtures.mjs -> fixtures/agreements/) does not cover, written the way small
// firms' own templates look, NOT designed around the detector's rules. Never tune on these.
//
//   node scripts/make-holdout.mjs && FIXTURE_DIR=fixtures/holdout npx vitest run test/detect.test.ts
//
// All firm names, people, emails, numbers and addresses are invented test data.
// Ground truth uses the same conventions as make-fixtures.mjs: PDF points, top-left origin;
// a field box is where a person writes, its bottom sits on the blank line; signature 24pt tall,
// initials 18pt, checkbox = glyph box + 1pt each side, everything else 14pt.
// Roles: client = client fills/signs, firm = firm countersigns, prefill = body blank filled from
// file data before sending. acceptRoles / acceptTypes mark genuinely ambiguous fields.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, PageSizes, rgb } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "fixtures", "holdout");
fs.mkdirSync(OUT, { recursive: true });

const LETTER = PageSizes.Letter; // [612, 792]
const A4 = PageSizes.A4; // [595.28, 841.89]
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);
const SHADE = rgb(0.9, 0.9, 0.9);
const FIXED_DATE = new Date("2026-02-02T12:00:00Z");

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
    this.fam = fam;
    this.font = fonts[fam];
    this.bold = fonts[fam + "Bold"];
    this.italic = fonts[fam + "Italic"];
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
    this.fields.push(e);
  }
  // field box sitting on a writing line at y=lineY spanning x..x+w
  onLine(field, x, lineY, w, size = this.fs) {
    const h = fieldH(field.type, size);
    this.expect({ ...field, x, y: lineY - h, w, h });
  }
  under(n, o = {}) {
    return "_".repeat(n);
  }
  nUnders(w, o = {}) {
    const uw = (o.font ?? this.font).widthOfTextAtSize("_", o.size ?? this.fs);
    return Math.max(3, Math.round(w / uw));
  }
  blank(x, base, w, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const n = this.nUnders(w, o);
    const s = "_".repeat(n);
    this.text(s, x, base, o);
    const ww = font.widthOfTextAtSize(s, size);
    if (field) this.onLine(field, x, base + 2, ww, size);
    return x + ww;
  }
  // "Label: ______" as ONE text item
  labeled(label, x, base, totalW, field, o = {}) {
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const pre = label + " ";
    const lw = font.widthOfTextAtSize(pre, size);
    const n = this.nUnders(totalW - lw, o);
    const u = "_".repeat(n);
    this.text(pre + u, x, base, o);
    if (field) this.onLine(field, x + lw, base + 2, font.widthOfTextAtSize(u, size), size);
    return x + lw + font.widthOfTextAtSize(u, size);
  }
  hline(x0, x1, lineY, o = {}) {
    this.page.drawLine({ start: { x: x0, y: this.H - lineY }, end: { x: x1, y: this.H - lineY }, thickness: o.thickness ?? 0.75, color: o.color ?? BLACK });
  }
  vline(x, y0, y1, o = {}) {
    this.page.drawLine({ start: { x, y: this.H - y0 }, end: { x, y: this.H - y1 }, thickness: o.thickness ?? 0.75, color: o.color ?? BLACK });
  }
  shade(x, y, w, h) {
    this.page.drawRectangle({ x, y: this.H - y - h, width: w, height: h, color: SHADE });
  }
  // drawn square checkbox (vector), glyph box s x s whose bottom sits at the baseline
  square(x, base, s, field) {
    this.page.drawRectangle({ x, y: this.H - base, width: s, height: s, borderWidth: 0.7, borderColor: BLACK });
    if (field) this.expect({ ...field, type: "checkbox", x: x - 1, y: base - s - 1, w: s + 2, h: s + 2 });
  }
  // "[ ]" text checkbox, as in "[ ]  label"
  bracket(x, base, label, field, o = {}) {
    const size = o.size ?? this.fs;
    const end = this.text("[ ]  " + label, x, base, o);
    if (field) this.expect({ ...field, type: "checkbox", x: x - 1, y: base - size * 0.8 - 1, w: size + 2, h: size + 2 });
    return end;
  }
  // Wrapped paragraph. parts: strings and { blank: width, field }. o.lead = bold run-in heading.
  // o.oneItem: each line is drawn as ONE text item including underscores (Word-export style);
  // otherwise words and blanks are separate items.
  rich(parts, o = {}) {
    if (typeof parts === "string") parts = [parts];
    const size = o.size ?? this.fs;
    const font = o.font ?? this.font;
    const indent = o.indent ?? 0;
    const maxW = this.textW - indent - (o.rightIndent ?? 0);
    const toks = [];
    let lastTrailing = true;
    if (o.lead) {
      for (const t of o.lead.split(" ")) toks.push({ t, f: this.bold, glue: false });
      lastTrailing = true;
    }
    for (const p of parts) {
      if (typeof p === "string") {
        const words = p.trim().split(/\s+/).filter(Boolean);
        if (!words.length) {
          lastTrailing = true;
          continue;
        }
        words.forEach((t, i) => toks.push({ t, f: font, glue: i === 0 && toks.length > 0 && !lastTrailing && !/^\s/.test(p) }));
        lastTrailing = /\s$/.test(p);
      } else {
        const n = this.nUnders(p.blank, { size, font });
        toks.push({ t: "_".repeat(n), f: font, glue: toks.length > 0 && !lastTrailing, field: p.field });
        lastTrailing = false;
      }
    }
    const sp = font.widthOfTextAtSize(" ", size);
    const lines = [];
    let cur = [];
    let cw = 0;
    for (const tok of toks) {
      const tw = tok.f.widthOfTextAtSize(tok.t, size);
      const add = (cur.length && !tok.glue ? sp : 0) + tw;
      if (cur.length && cw + add > maxW) {
        lines.push(cur);
        cur = [];
        cw = 0;
        tok.glue = false;
      }
      cw += (cur.length && !tok.glue ? sp : 0) + tw;
      cur.push(tok);
    }
    if (cur.length) lines.push(cur);
    const lh = size * this.lead;
    for (const ln of lines) {
      this.ensure(lh);
      const base = this.y + size;
      const x0 = this.m + indent;
      // runs: consecutive tokens of the same font (and, unless oneItem, not blanks)
      let x = x0;
      let i = 0;
      while (i < ln.length) {
        let j = i + 1;
        const isBlank = (k) => !!ln[k].field;
        while (j < ln.length && ln[j].f === ln[i].f && (o.oneItem || (!isBlank(j) && !isBlank(i) && !(ln[j].t.startsWith("_"))))) j++;
        let s = "";
        const marks = [];
        for (let k = i; k < j; k++) {
          if (k > i && !ln[k].glue) s += " ";
          if (ln[k].field) marks.push({ at: s.length, tok: ln[k] });
          s += ln[k].t;
        }
        const f = ln[i].f;
        for (const mk of marks) {
          const bx = x + f.widthOfTextAtSize(s.slice(0, mk.at), size);
          this.onLine({ ...mk.tok.field, page: this.pi }, bx, base + 2, f.widthOfTextAtSize(mk.tok.t, size), size);
        }
        x = this.text(s, x, base, { size, font: f });
        if (j < ln.length && !ln[j].glue) x += sp;
        i = j;
      }
      this.y += lh;
    }
    this.y += o.after ?? size * 0.55;
  }
  para(body, o = {}) {
    this.rich([body], o);
  }
  title(s, size = 14, after = 10, align = "center") {
    this.ensure(size * 2);
    const w = this.bold.widthOfTextAtSize(s, size);
    this.text(s, align === "center" ? (this.W - w) / 2 : this.m, this.y + size, { size, font: this.bold });
    this.y += size * 1.4 + after;
  }
  heading(s, o = {}) {
    const size = o.size ?? this.fs + 1;
    this.ensure(size * 4);
    this.y += o.before ?? 4;
    this.text(s, this.m, this.y + size, { size, font: this.bold });
    this.y += size * 1.5;
  }
  bullets(items, o = {}) {
    for (const it of items) {
      const base = this.y + this.fs;
      this.ensure(this.fs * this.lead);
      this.text("•", this.m + (o.indent ?? 10), this.y + this.fs);
      this.rich([it], { indent: (o.indent ?? 10) + 12, after: 2 });
      void base;
    }
    this.y += 4;
  }
  // simple ruled table with fixed column widths; rows = arrays of strings; first row may be header
  table(cols, rows, o = {}) {
    const rowH = o.rowH ?? this.fs * 1.9;
    const size = o.size ?? this.fs;
    const x0 = o.x ?? this.m;
    const total = cols.reduce((a, b) => a + b, 0);
    this.ensure(rowH * rows.length + 6);
    let y = this.y;
    rows.forEach((r, ri) => {
      if (ri === 0 && o.header) this.shade(x0, y, total, rowH);
      let x = x0;
      r.forEach((c, ci) => {
        this.text(c, x + 4, y + rowH / 2 + size * 0.35, { size, font: ri === 0 && o.header ? this.bold : this.font });
        x += cols[ci];
      });
      this.hline(x0, x0 + total, y, { thickness: 0.5 });
      y += rowH;
    });
    this.hline(x0, x0 + total, y, { thickness: 0.5 });
    let x = x0;
    for (const c of [0, ...cols]) {
      x += c;
      this.vline(x, this.y, y, { thickness: 0.5 });
    }
    this.y = y + (o.after ?? 10);
  }
  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      this.footer?.(this, i, n);
    });
  }
}

const clauses = (w, list, o = {}) =>
  list.forEach(([h, b], i) => w.rich(Array.isArray(b) ? b : [b], { lead: `${(o.start ?? 1) + i}. ${h}`, ...(o.para ?? {}) }));

// ---------------------------------------------------------------- output
const written = [];
async function holdout(name, meta, opts, draw) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title ?? name);
  pdf.setAuthor("Countersign holdout corpus (fake data)");
  pdf.setProducer("countersign make-holdout");
  pdf.setCreator("countersign make-holdout");
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
  for (const f of w.fields) {
    const [pw, ph] = w.size;
    if (f.x < 0 || f.y < 0 || f.x + f.w > pw || f.y + f.h > ph) throw new Error(`${name}: field off page ${JSON.stringify(f)}`);
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  fs.writeFileSync(path.join(OUT, name + ".pdf"), bytes);
  const fields = w.fields.slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const expected = {
    firmName: meta.firmName,
    description: meta.description,
    split: "holdout",
    pages: w.pages.length,
    pageSize: [r1(w.W), r1(w.H)],
    fields,
    warnings: meta.warnings ?? [],
    ...(meta.note ? { note: meta.note } : {}),
  };
  fs.writeFileSync(path.join(OUT, name + ".expected.json"), JSON.stringify(expected, null, 2) + "\n");
  written.push(`${name}.pdf  (${w.pages.length}p, ${fields.length} fields)`);
}

const pageOfN = (prefix, size = 7.5) => (w, i, n) => {
  const s = `${prefix}Page ${i + 1} of ${n}`;
  w.text(s, (w.W - w.wid(s, { size })) / 2, w.H - 30, { size, color: GREY });
};

// ================================================================= H01 marketing agency SOW
await holdout(
  "h01-marketing-agency-sow",
  {
    firmName: "Saltmarsh Creative Co., LLC",
    description:
      "Letter, Helvetica 10. Agency SOW under an MSA: preamble blanks (MSA date, client name), a project-summary block of 'Label' + separate underscore items, monthly retainer blank, deliverables table. Two-column sign-off: left 'Saltmarsh Creative Co., LLC', right 'Accepted by:' with an extra 'Client company:' row; rows 'Label: ____' single items.",
    pageRange: [2, 2],
  },
  { font: "Helvetica", fontSize: 10, pageSize: LETTER, margin: 60, footer: pageOfN("Saltmarsh Creative Co.  |  SOW template rev. 7  |  ") },
  (w) => {
    w.text("SALTMARSH", w.m, w.y + 16, { size: 16, font: w.bold });
    w.text("creative co.", w.m + w.wid("SALTMARSH ", { size: 16, font: w.bold }), w.y + 16, { size: 12, color: GREY });
    w.y += 40;
    w.title("STATEMENT OF WORK", 13, 8);
    w.rich([
      `This Statement of Work (this "SOW") is issued under the Master Services Agreement dated `,
      { blank: 90, field: { type: "date", role: "prefill", note: "MSA dated ____" } },
      ` (the "Agreement") between Saltmarsh Creative Co., LLC ("Saltmarsh," "we" or "us") and `,
      { blank: 150, field: { type: "company", role: "prefill", acceptTypes: ["name"], note: 'and ____ ("Client")' } },
      ` ("Client" or "you"). Capitalized terms not defined in this SOW have the meanings given in the Agreement. If this SOW conflicts with the Agreement, the Agreement controls.`,
    ]);
    w.heading("Project Summary", { before: 6 });
    for (const [label, type, extra] of [
      ["Project name", "text", {}],
      ["SOW start date", "date", {}],
      ["SOW end date", "date", {}],
      ["Client project lead", "name", { acceptRoles: ["client"] }],
      ["Lead email", "email", { acceptRoles: ["client"] }],
    ]) {
      const base = w.y + 10;
      w.text(label, w.m + 8, base, { font: w.bold });
      w.blank(w.m + 130, base, 230, { type, role: "prefill", note: label, ...extra });
      w.y += 20;
    }
    w.advance(6);
    w.heading("1. Scope of Services");
    w.para("Saltmarsh will plan, produce and manage the following services for Client during the SOW term:");
    w.bullets([
      "Brand campaign strategy: audience research, messaging framework and a quarterly campaign calendar.",
      "Paid social management on two platforms selected by Client, including creative refreshes every four weeks.",
      "Monthly content package: eight static posts, two short-form videos and one long-form blog article.",
      "Reporting: a monthly performance dashboard and a 45-minute review call with the Client project lead.",
    ]);
    w.heading("2. Deliverables and Timeline");
    w.table(
      [150, 230, 112],
      [
        ["Phase", "Deliverable", "Target"],
        ["Discovery", "Kickoff workshop, audience brief", "Weeks 1-2"],
        ["Strategy", "Messaging framework, campaign calendar", "Weeks 3-4"],
        ["Production", "First content package, ad creative", "Weeks 5-6"],
        ["Optimization", "Monthly refresh and reporting", "Ongoing"],
      ],
      { header: true, rowH: 18 },
    );
    w.heading("3. Fees");
    w.rich([
      "Client will pay a monthly retainer of $",
      { blank: 80, field: { type: "text", role: "prefill", note: "monthly retainer $____" } },
      " for the services in Section 1, invoiced on the first business day of each month. Paid media spend is not included in the retainer; it is billed to Client's own ad accounts or passed through at cost with a 10% management fee. Work outside this SOW requires a written change request and is billed at $165 per hour.",
    ]);
    w.heading("4. Assumptions");
    w.bullets([
      "Client provides brand guidelines, logo files and product information within five business days of kickoff.",
      "Client consolidates feedback from its reviewers and returns one set of comments per round; two rounds of revisions are included per deliverable.",
      "Client owns and pays for its ad platform accounts and grants Saltmarsh administrator access for the SOW term.",
      "Timelines move day-for-day with any delay in Client approvals or materials.",
    ]);
    w.heading("5. Acceptance");
    w.para(
      "Each deliverable is deemed accepted five business days after delivery unless you send us written notice describing how it does not conform to this SOW. We will correct conforming defects and resubmit the deliverable for review. Use of a deliverable in a live campaign is acceptance of that deliverable.",
    );
    w.heading("6. Term and Termination");
    w.para(
      "This SOW runs from the start date to the end date above and renews month to month afterward unless either party gives thirty (30) days' written notice. Fees for the notice period remain payable. On termination we will hand over all final files for deliverables you have paid for.",
    );
    w.advance(8);
    w.ensure(190);
    w.para("The parties' authorized representatives have signed this SOW below.");
    w.advance(6);
    const colW = (w.textW - 40) / 2;
    const L = w.m;
    const R = w.m + colW + 40;
    let base = w.y + 10;
    w.text("Saltmarsh Creative Co., LLC", L, base, { font: w.bold });
    w.text("Accepted by:", R, base, { font: w.bold });
    base += 28;
    w.labeled("Client company:", R, base, colW, { type: "company", role: "client", acceptRoles: ["prefill"], acceptTypes: ["name"], note: "Accepted by / Client company" });
    for (const [label, type] of [
      ["By:", "signature"],
      ["Name:", "name"],
      ["Title:", "title"],
      ["Date:", "date"],
    ]) {
      base += type === "signature" ? 34 : 26;
      w.labeled(label, L, base, colW, { type, role: "firm", note: `Saltmarsh / ${label}` });
      w.labeled(label, R, base, colW, { type, role: "client", note: `Accepted by / ${label}` });
    }
    w.y = base + 20;
  },
);

// ================================================================= H02 accounting engagement letter
await holdout(
  "h02-accounting-engagement-letter",
  {
    firmName: "Wexley & Brandt CPAs, LLP",
    description:
      "Letter, TimesRoman 11. CPA review-engagement letter, firm 'we' / client 'you'. Blanks for date, addressee, salutation, entity name in the body and the fee. Firm signs on a drawn line under 'Wexley & Brandt CPAs, LLP' with the partner name printed under the line. 'RESPONSE:' block names the entity in a blank, then Management and Governance signature/title/date rows (label left, drawn line right).",
    pageRange: [2, 2],
  },
  { font: "TimesRoman", fontSize: 11, pageSize: LETTER, margin: 72, leading: 1.35, footer: (w, i) => i > 0 && w.text(`Page ${i + 1}`, w.W - w.m - 30, w.H - 36, { size: 9 }) },
  (w) => {
    const hdr = "WEXLEY & BRANDT";
    w.text(hdr, (w.W - w.wid(hdr, { size: 15, font: w.bold })) / 2, w.y + 15, { size: 15, font: w.bold });
    const sub = "Certified Public Accountants  ·  0 Example Plaza, Suite 000  ·  Anytown, ST 00000  ·  wexleybrandt.example.com";
    w.text(sub, (w.W - w.wid(sub, { size: 8.5 })) / 2, w.y + 29, { size: 8.5, color: GREY });
    w.hline(w.m, w.W - w.m, w.y + 36, { thickness: 0.5 });
    w.y += 58;
    w.rich([{ blank: 120, field: { type: "date", role: "prefill", note: "letter date" } }], { after: 8 });
    w.rich(["To: ", { blank: 200, field: { type: "company", role: "prefill", acceptTypes: ["name"], note: "To: ____" } }], { after: 8 });
    w.rich(["Dear ", { blank: 150, field: { type: "name", role: "prefill", note: "Dear ____:" } }, ":"], { after: 8 });
    w.rich([
      "We are pleased to confirm our understanding of the services we will provide ",
      { blank: 140, field: { type: "company", role: "prefill", acceptTypes: ["name"], note: 'provide ____ ("you")' } },
      ` ("you" or "the Company") for the year ending December 31, 2026. We will review the Company's financial statements, which comprise the balance sheet and the related statements of income, changes in equity and cash flows, and the related notes, and issue a written report on them.`,
    ]);
    const body = [
      [
        "Our Responsibilities.",
        "The objective of a review is to obtain limited assurance that there are no material modifications that should be made to the financial statements for them to be in accordance with accounting principles generally accepted in the United States of America. A review is substantially less in scope than an audit, and we will not express an opinion on the financial statements as a whole. We will conduct our review in accordance with the Statements on Standards for Accounting and Review Services, which require us to apply analytical procedures and make inquiries of management.",
      ],
      [
        "Your Responsibilities.",
        "You are responsible for the preparation and fair presentation of the financial statements, for designing and maintaining internal control relevant to their preparation, for preventing and detecting fraud, and for identifying and complying with the laws and regulations that apply to your activities. You agree to give us all records, documentation and information we request, unrestricted access to the people we need to speak with, and, at the end of the engagement, a letter confirming certain representations made during the review.",
      ],
      [
        "Nonattest Services.",
        "We will also prepare the Company's federal and state income tax returns for the same year. You agree to assume all management responsibilities for these services, to oversee them through an individual with suitable skill and knowledge, and to evaluate and accept responsibility for their results.",
      ],
      [
        "Fees.",
        ["Our fee for these services will be $", { blank: 70, field: { type: "text", role: "prefill", note: "fee $____" } }, ", plus out-of-pocket costs such as report production, delivery and technology charges. Our invoices are due on presentation. If your records need significant adjustment, or if we meet unexpected circumstances, we will tell you before incurring additional time and agree a revised fee with you."],
      ],
      [
        "Records and Retention.",
        "Your original records remain your property and will be returned to you at the end of the engagement. Our working papers are our property and are kept for seven years, after which they may be destroyed without further notice to you. Copies of our working papers may be provided to regulators when required by law or professional standards.",
      ],
      [
        "Electronic Communication.",
        "We may communicate with you and transfer files by email and through our client portal. Although we use reasonable security measures, we cannot guarantee that electronic communications will be free of interception, and you agree that we are not responsible for losses caused by such interception that were not the result of our negligence.",
      ],
      [
        "Dispute Resolution.",
        "If a dispute arises out of this engagement, both parties agree first to try to resolve it through non-binding mediation administered by a mutually agreed mediator, with the costs shared equally, before either party starts litigation.",
      ],
    ];
    for (const [h, b] of body) w.rich(Array.isArray(b) ? b : [b], { lead: h });
    w.para(
      "We appreciate the opportunity to be of service to you. If this letter correctly expresses your understanding, please sign the enclosed copy where indicated and return it to us.",
    );
    w.ensure(130);
    let base = w.y + 11;
    w.text("Sincerely,", w.m, base);
    base += 18;
    w.text("Wexley & Brandt CPAs, LLP", w.m, base);
    base += 40;
    w.hline(w.m, w.m + 230, base + 2);
    w.onLine({ type: "signature", role: "firm", note: "firm signature line" }, w.m, base + 2, 230);
    w.text("Priya Fakehart, CPA, Engagement Partner", w.m, base + 15, { size: 10 });
    w.y = base + 40;
    w.ensure(230);
    base = w.y + 11;
    w.text("RESPONSE:", w.m, base, { font: w.bold });
    w.y = base + 8;
    w.rich(["This letter correctly sets forth the understanding of ", { blank: 170, field: { type: "company", role: "prefill", acceptTypes: ["name"], note: "understanding of ____." } }, "."]);
    base = w.y + 18;
    const row = (label, type, note) => {
      w.text(label, w.m, base);
      const x0 = w.m + 140;
      w.hline(x0, x0 + 230, base + 2);
      w.onLine({ type, role: "client", note }, x0, base + 2, 230);
    };
    row("Management signature:", "signature", "Management signature");
    base += 26;
    row("Title:", "title", "Management title");
    base += 26;
    row("Date:", "date", "Management date");
    base += 40;
    row("Governance signature:", "signature", "Governance signature");
    base += 26;
    row("Title:", "title", "Governance title");
    base += 26;
    row("Date:", "date", "Governance date");
    w.y = base + 20;
  },
);

// ================================================================= H03 home-services contractor
await holdout(
  "h03-home-improvement-contract",
  {
    firmName: "Ironbark Roofing & Exteriors, Inc.",
    description:
      "Letter, Helvetica 8.5, dense one-pager. Boxed job-info grid ('Label' + separate underscores, two per row), proposal number blank in body, owner initials next to the right-to-cancel clause, two drawn-square acknowledgment checkboxes, and 'X ________' signature lines with small captions under, firm block 'CONTRACTOR: Ironbark Roofing & Exteriors, Inc.'.",
    pageRange: [1, 1],
  },
  { font: "Helvetica", fontSize: 8.5, pageSize: LETTER, margin: 42, bottom: 40, leading: 1.3, footer: pageOfN("Ironbark HIC-2026  |  ", 7) },
  (w) => {
    w.text("IRONBARK", w.m, w.y + 20, { size: 20, font: w.bold });
    w.text("ROOFING & EXTERIORS", w.m, w.y + 31, { size: 8, font: w.bold, color: GREY });
    const r = "Contractor Lic. #HIC-0000000  ·  (555) 010-0199  ·  office@ironbark.example.com";
    w.text(r, w.W - w.m - w.wid(r, { size: 8 }), w.y + 20, { size: 8, color: GREY });
    w.y += 46;
    w.title("HOME IMPROVEMENT CONTRACT", 13, 6);
    // job box
    const boxTop = w.y;
    const colW = w.textW / 2;
    const rows = [
      [
        ["Owner name(s):", "name", {}],
        ["Phone:", "text", { acceptRoles: ["client"] }],
      ],
      [
        ["Job address:", "text", {}],
        ["Email:", "email", { acceptRoles: ["client"] }],
      ],
      [
        ["Contract price: $", "text", {}],
        ["Deposit (max 10%): $", "text", {}],
      ],
      [
        ["Est. start date:", "date", {}],
        ["Est. completion:", "date", { acceptTypes: ["text"] }],
      ],
    ];
    let base = boxTop + 18;
    for (const rr of rows) {
      rr.forEach(([label, type, extra], ci) => {
        const x = w.m + 8 + ci * colW;
        const lx = w.text(label, x, base, { font: w.bold });
        const gap = label.endsWith("$") ? 1 : 4;
        w.blank(lx + gap, base, x + colW - 16 - lx - gap, { type, role: "prefill", note: label, ...extra });
      });
      base += 20;
    }
    const boxBot = base - 6;
    w.page.drawRectangle({ x: w.m, y: w.H - boxBot, width: w.textW, height: boxBot - boxTop, borderWidth: 0.8, borderColor: BLACK });
    w.y = boxBot + 12;
    w.rich([
      "1. WORK. Contractor will furnish all labor, materials and equipment to complete the work described in Contractor's Proposal No. ",
      { blank: 60, field: { type: "text", role: "prefill", note: "Proposal No. ____" } },
      ' (the "Work"), which is attached and made part of this Contract. Work includes tear-off of existing roofing to the deck, replacement of up to two sheets of damaged decking, ice and water shield at eaves and valleys, synthetic underlayment, drip edge, architectural shingles, ridge venting and haul-away of all debris.',
    ]);
    const terms = [
      "2. PAYMENT. The deposit is due on signing. The balance is due on substantial completion. Payments more than ten (10) days late bear interest at 1.5% per month. Contractor will not demand payment for work not yet performed or materials not yet delivered to the job site.",
      "3. CHANGES. Any change to the Work, including rotten decking beyond the allowance above, will be described in a written change order signed by Owner showing the added or reduced cost and any change to the schedule. Decking beyond the allowance is replaced at $85 per sheet installed.",
      "4. PERMITS AND INSPECTIONS. Contractor will obtain the building permit and schedule required inspections. The permit fee is included in the contract price.",
      "5. WARRANTY. Contractor warrants its workmanship for five (5) years from completion. Shingle and material warranties are provided by the manufacturer and are passed through to Owner. This warranty does not cover damage from storms exceeding manufacturer wind ratings, foot traffic or alterations by others.",
      "6. MECHANIC'S LIEN NOTICE. Anyone who helps improve your property and is not paid may have the right to record a lien against your property. To protect yourself, you may request lien waivers from Contractor and its suppliers with each payment.",
    ];
    for (const t of terms) w.para(t, { after: 4 });
    w.rich(
      [
        "7. OWNER'S RIGHT TO CANCEL. YOU MAY CANCEL THIS CONTRACT AT ANY TIME BEFORE MIDNIGHT OF THE THIRD BUSINESS DAY AFTER THE DATE YOU SIGN IT. SEE THE ATTACHED NOTICE OF CANCELLATION FORM FOR AN EXPLANATION OF THIS RIGHT.",
      ],
      { font: w.bold, after: 6 },
    );
    {
      const b = w.y + 9;
      const lx = w.text("Owner's initials:", w.W - w.m - 150, b);
      w.blank(lx + 4, b, 60, { type: "initials", role: "client", note: "owner's initials (right to cancel)" });
      w.y += 22;
    }
    w.para(
      "8. ENTIRE AGREEMENT. This Contract, the Proposal and any signed change orders are the entire agreement between Owner and Contractor. This Contract is governed by the laws of the state where the property is located.",
    );
    w.ensure(200);
    w.advance(4);
    for (const t of [
      "Owner acknowledges receipt of a completed copy of this Contract and two copies of the Notice of Cancellation.",
      "Owner has received the lead-safe renovation pamphlet (required for homes built before 1978).",
    ]) {
      const b = w.y + 9;
      w.square(w.m + 2, b, 8, { role: "client", note: t.slice(0, 32) });
      w.text(t, w.m + 16, b);
      w.y += 16;
    }
    w.advance(14);
    base = w.y + 10;
    w.text("OWNER", w.m, base, { font: w.bold });
    base += 34;
    const xline = (x, b, wd, field, caption) => {
      w.text("X", x, b, { size: 12, font: w.bold });
      const e = w.blank(x + 12, b, wd, field);
      w.text(caption, x + 12, b + 11, { size: 7, color: GREY });
      return e;
    };
    xline(w.m, base, 250, { type: "signature", role: "client", note: "OWNER X ____" }, "Owner signature");
    w.text("Date", w.m + 300, base);
    w.blank(w.m + 300 + w.wid("Date "), base, 120, { type: "date", role: "client", note: "OWNER Date" });
    base += 30;
    w.text("Print name", w.m + 12, base);
    w.blank(w.m + 12 + w.wid("Print name "), base, 250 - w.wid("Print name "), { type: "name", role: "client", note: "OWNER Print name" });
    base += 34;
    w.text("CONTRACTOR: Ironbark Roofing & Exteriors, Inc.", w.m, base, { font: w.bold });
    base += 34;
    xline(w.m, base, 250, { type: "signature", role: "firm", note: "CONTRACTOR X ____" }, "Authorized representative");
    w.text("Date", w.m + 300, base);
    w.blank(w.m + 300 + w.wid("Date "), base, 120, { type: "date", role: "firm", note: "CONTRACTOR Date" });
    w.y = base + 24;
  },
);

// ================================================================= H04 staffing / permanent placement (UK)
await holdout(
  "h04-staffing-placement-terms",
  {
    firmName: "Harrowgate Talent Partners Ltd",
    description:
      "A4, Helvetica 9.5. UK permanent-recruitment terms of business with fee and rebate tables, 'Schedule 1 – Client Details' (labels + drawn lines, client may complete), and a ruled signature TABLE with header row 'Party | Signature | Date'; party cells read 'For and on behalf of ...'; a 'Print name and position' line under the table.",
    pageRange: [2, 2],
  },
  { font: "Helvetica", fontSize: 9.5, pageSize: A4, margin: 56, footer: pageOfN("Harrowgate Talent Partners Ltd  -  Terms of Business (Permanent) v4.1  -  ") },
  (w) => {
    w.title("TERMS OF BUSINESS FOR THE INTRODUCTION OF PERMANENT CANDIDATES", 12, 8);
    w.para(
      `These terms are made between Harrowgate Talent Partners Ltd, a company registered in England and Wales under number 00000000 ("Harrowgate" or "the Agency"), and the client whose details are set out in Schedule 1 ("the Client"). They apply to every Introduction made by the Agency to the Client and override any terms the Client may put forward.`,
    );
    const T = [
      ["Definitions.", `"Candidate" means a person Introduced by the Agency to the Client. "Introduction" means the Client's receipt of a Candidate's CV or other information identifying the Candidate, or the Client's interview of a Candidate, in each case from the Agency. "Engagement" means the employment or engagement of a Candidate by the Client or any associated company, directly or through a third party, on a permanent, temporary or contract basis. "Remuneration" means the Candidate's gross annual base salary plus guaranteed bonuses and allowances for the first twelve months.`],
      ["Agency's services.", "The Agency will use reasonable endeavours to Introduce suitable Candidates for the vacancies the Client notifies. The Agency checks identity and right to work and takes up references where the Candidate consents, but the Client remains responsible for satisfying itself as to the suitability of any Candidate, including any qualifications, medical checks or criminal record checks required for the role."],
      ["Client's obligations.", "The Client will tell the Agency promptly of any offer made to, or accepted by, a Candidate, and of the Remuneration agreed. Introductions are confidential: the Client may not pass a Candidate's details to any third party. If it does, and that third party Engages the Candidate within twelve months, the Client will pay the fee as though it had Engaged the Candidate itself."],
      ["Fees.", "The Client will pay a fee on the Engagement of any Candidate within twelve months of the Introduction, calculated as a percentage of the Candidate's Remuneration as set out below. Where the Remuneration is not known, the fee will be calculated on the Agency's reasonable estimate for the role. VAT is payable in addition."],
    ];
    clauses(w, T);
    w.table(
      [260, 223],
      [
        ["Candidate's Remuneration", "Fee (% of Remuneration)"],
        ["Up to £39,999", "15%"],
        ["£40,000 to £69,999", "18%"],
        ["£70,000 and above", "20%"],
      ],
      { header: true, rowH: 17, size: 9 },
    );
    const T2 = [
      ["Invoicing and payment.", "The Agency will invoice the fee on the Candidate's start date. Invoices are payable within fourteen (14) days. The Agency may charge interest on late payments under the Late Payment of Commercial Debts (Interest) Act 1998."],
      ["Rebate.", "If the Candidate's employment ends within the periods below, other than by redundancy or the Client's breach, the Agency will refund the percentage of the fee shown, provided the fee was paid on time and the Client notifies the Agency in writing within seven (7) days of the employment ending."],
    ];
    clauses(w, T2, { start: 5 });
    w.table(
      [260, 223],
      [
        ["Employment ends within", "Refund of fee"],
        ["0 to 4 weeks of start", "100%"],
        ["5 to 8 weeks of start", "50%"],
        ["9 to 12 weeks of start", "25%"],
      ],
      { header: true, rowH: 17, size: 9 },
    );
    const T3 = [
      ["Withdrawn offers.", "If the Client withdraws an offer after the Candidate has accepted it, the Client will pay a cancellation fee of 25% of the fee that would have been payable on Engagement."],
      ["Liability.", "The Agency is not liable for any loss, expense or damage arising from the Introduction or Engagement of a Candidate, or from any act or omission of a Candidate, except to the extent caused by the Agency's negligence. Nothing in these terms limits liability for death or personal injury caused by negligence or for fraud."],
      ["Data protection.", "Each party will comply with the UK GDPR and the Data Protection Act 2018 in respect of Candidate personal data and will process it only for the purposes of recruitment. The Client will delete the details of unsuccessful Candidates within six months."],
      ["Conduct of Employment Agencies.", "The Agency acts as an employment agency within the meaning of the Conduct of Employment Agencies and Employment Businesses Regulations 2003 when Introducing Candidates for permanent roles."],
      ["General.", "These terms, together with Schedule 1, are the entire agreement between the parties. No variation is effective unless agreed in writing by a director of the Agency. These terms are governed by the law of England and Wales and the courts of England and Wales have exclusive jurisdiction."],
    ];
    clauses(w, T3, { start: 7 });
    w.ensure(420);
    w.advance(6);
    w.heading("Schedule 1 – Client Details", { size: 10.5 });
    w.para("To be completed by the Client and returned with this agreement.", { font: w.italic });
    let base = w.y + 12;
    for (const [label, type, extra] of [
      ["Client legal name", "company", { acceptTypes: ["name"] }],
      ["Registered office", "text", {}],
      ["Company number", "text", {}],
      ["Hiring contact", "name", {}],
      ["Invoice email", "email", {}],
      ["Purchase order no. (if any)", "text", {}],
    ]) {
      w.text(label, w.m, base);
      const x0 = w.m + 150;
      w.hline(x0, w.W - w.m, base + 2, { thickness: 0.5 });
      w.onLine({ type, role: "prefill", acceptRoles: ["client"], note: `Schedule 1 / ${label}`, ...extra }, x0, base + 2, w.W - w.m - x0);
      base += 22;
    }
    w.y = base + 4;
    w.para("Signed by the parties' authorised signatories:");
    // signature table
    const cols = [170, 200, w.textW - 370];
    const x0 = w.m;
    const top = w.y + 4;
    const hdrH = 18;
    const rowH = 46;
    w.shade(x0, top, w.textW, hdrH);
    ["Party", "Signature", "Date"].forEach((h, i) => w.text(h, x0 + cols.slice(0, i).reduce((a, b) => a + b, 0) + 6, top + 12.5, { font: w.bold }));
    const parties = [
      ["For and on behalf of", "Harrowgate Talent Partners Ltd", "firm"],
      ["For and on behalf of", "the Client", "client"],
    ];
    parties.forEach(([a, b, role], ri) => {
      const rt = top + hdrH + ri * rowH;
      const rb = rt + rowH;
      w.text(a, x0 + 6, rt + 18);
      w.text(b, x0 + 6, rt + 31, { font: w.bold });
      const sx = x0 + cols[0];
      w.expect({ type: "signature", role, x: sx + 6, y: rb - 4 - 24, w: cols[1] - 12, h: 24, note: `table / ${b} / Signature` });
      const dx = sx + cols[1];
      w.expect({ type: "date", role, x: dx + 6, y: rb - 4 - 14, w: cols[2] - 12, h: 14, note: `table / ${b} / Date` });
    });
    const bot = top + hdrH + parties.length * rowH;
    for (const yy of [top, top + hdrH, top + hdrH + rowH, bot]) w.hline(x0, x0 + w.textW, yy, { thickness: 0.6 });
    let cx = x0;
    for (const c of [0, ...cols]) {
      cx += c;
      w.vline(cx, top, bot, { thickness: 0.6 });
    }
    base = bot + 28;
    const lbl = "Print name and position of Client signatory:";
    w.text(lbl, w.m, base);
    const lx = w.m + w.wid(lbl) + 6;
    w.hline(lx, w.W - w.m, base + 2, { thickness: 0.5 });
    w.onLine({ type: "name", role: "client", acceptTypes: ["title"], note: "Print name and position of Client signatory" }, lx, base + 2, w.W - w.m - lx);
    w.y = base + 20;
  },
);

// ================================================================= H05 IT managed services (order form + terms)
await holdout(
  "h05-it-managed-services",
  {
    firmName: "Northgate Managed IT Services, LLC",
    description:
      "Letter, Helvetica 9. Page 1 = order form: ruled 4-column grid with EMPTY value cells (no underscores) for customer details, '[ ]' service-tier checkboxes, then the only signature block: two columns, CUSTOMER on the LEFT and the firm on the right, rows 'Authorized Signature:' / 'Printed Name:' / 'Title:' / 'Date:' with drawn lines. Pages 2+ = Managed Services Terms with an SLA table and no blanks.",
    pageRange: [5, 5],
    note: "Value cells in the order-form grid are empty table cells; their field boxes sit on the cell's bottom rule. Tier checkboxes are client-ticked but a firm could pre-tick them (acceptRoles prefill).",
  },
  { font: "Helvetica", fontSize: 9, pageSize: LETTER, margin: 54, footer: pageOfN("Northgate MSA-ORD rev. 2026.2  |  Customer Confidential  |  ") },
  (w) => {
    w.text("NORTHGATE", w.m, w.y + 18, { size: 18, font: w.bold });
    w.text("MANAGED IT SERVICES", w.m, w.y + 29, { size: 7.5, color: GREY });
    {
      const s8 = { size: 8 };
      const u = "_".repeat(12);
      const ox = w.W - w.m - w.wid(`Order Form No. ${u} (office use)`, s8);
      w.text(`Order Form No. ${u} (office use)`, ox, w.y + 18, { ...s8, color: GREY });
      w.onLine({ type: "text", role: "prefill", note: "Order Form No. ____ (office use)" }, ox + w.wid("Order Form No. ", s8), w.y + 20, w.wid(u, s8), 8);
    }
    w.y += 44;
    w.title("MANAGED SERVICES ORDER FORM", 12.5, 6);
    w.para(
      `This Order Form is entered into between Northgate Managed IT Services, LLC ("Northgate") and the customer identified below ("Customer"), and is governed by the Northgate Managed Services Terms attached (the "Terms"). Together the Order Form and the Terms form the "Agreement".`,
    );
    // grid
    const cols = [104, 148, 104, 148];
    const rowH = 22;
    const top = w.y + 2;
    const cells = [
      [["Customer legal name", "company", { acceptTypes: ["name"] }], ["Billing address", "text", {}]],
      [["Primary contact", "name", {}], ["Contact email", "email", {}]],
      [["Service start date", "date", {}], ["Covered users", "text", {}]],
      [["Monthly fee (USD)", "text", {}], ["Initial term", null, "36 months"]],
    ];
    cells.forEach((row, ri) => {
      const rt = top + ri * rowH;
      const rb = rt + rowH;
      row.forEach(([label, type, extra], pi) => {
        const lx = w.m + (pi ? cols[0] + cols[1] : 0);
        w.shade(lx, rt, cols[0], rowH);
        w.text(label, lx + 4, rt + 14, { font: w.bold, size: 8.5 });
        const vx = lx + cols[0];
        if (type) w.expect({ type, role: "prefill", x: vx + 4, y: rb - 3 - 14, w: cols[1] - 8, h: 14, note: `order form / ${label}`, ...extra });
        else w.text(extra, vx + 4, rt + 14);
      });
    });
    const bot = top + cells.length * rowH;
    for (let i = 0; i <= cells.length; i++) w.hline(w.m, w.m + w.textW, top + i * rowH, { thickness: 0.5 });
    let cx = w.m;
    for (const c of [0, ...cols]) {
      cx += c;
      w.vline(cx, top, bot, { thickness: 0.5 });
    }
    w.y = bot + 14;
    w.heading("Service tier (select one)", { size: 9.5 });
    {
      const b = w.y + 9;
      let x = w.m + 6;
      for (const t of ["Essentials", "Professional", "Enterprise"]) {
        x = w.bracket(x, b, t, { role: "client", acceptRoles: ["prefill"], note: `tier ${t}` }) + 40;
      }
      w.y += 20;
    }
    w.para(
      "Essentials covers remote help desk (business hours), patching and monitoring for covered users. Professional adds on-site support, backup management and quarterly business reviews. Enterprise adds 24x7 incident response, a named virtual CIO and annual security assessments. Per-user pricing applies above the covered user count at the rates in the Terms.",
    );
    w.para(
      "By signing below, Customer agrees to this Order Form and the Terms. This Order Form is effective on the date of the last signature.",
      { font: w.bold },
    );
    w.ensure(170);
    w.advance(8);
    const colW = (w.textW - 36) / 2;
    let base = w.y + 9.5;
    const L = w.m;
    const R = w.m + colW + 36;
    w.text("CUSTOMER", L, base, { font: w.bold, size: 9.5 });
    w.text("NORTHGATE MANAGED IT SERVICES, LLC", R, base, { font: w.bold, size: 9.5 });
    const labW = 92;
    for (const [label, type] of [
      ["Authorized Signature:", "signature"],
      ["Printed Name:", "name"],
      ["Title:", "title"],
      ["Date:", "date"],
    ]) {
      base += type === "signature" ? 36 : 24;
      for (const [x, role] of [
        [L, "client"],
        [R, "firm"],
      ]) {
        w.text(label, x, base);
        w.hline(x + labW, x + colW, base + 2);
        w.onLine({ type, role, note: `${role === "client" ? "CUSTOMER" : "NORTHGATE"} / ${label}` }, x + labW, base + 2, colW - labW);
      }
    }
    w.newPage();
    w.title("NORTHGATE MANAGED SERVICES TERMS", 12, 6);
    const T = [
      ["Services.", "Northgate will provide the managed services for the tier selected in the Order Form (the \"Services\") to the devices and users listed in Northgate's onboarding inventory. Northgate will keep the inventory current as Customer adds or retires devices. Services exclude hardware repair, software development, training, and work on systems not in the inventory, which Northgate may perform at its then-current time-and-materials rates."],
      ["Onboarding.", "During the first thirty (30) days Northgate will install its monitoring agent, document the Customer's network, collect administrator credentials into Northgate's encrypted vault and remediate critical findings. Remediation of non-critical findings is quoted separately."],
      ["Service levels.", "Northgate will respond to and work on incidents according to the priority table below. Response time runs from the creation of a ticket through Northgate's portal, email or phone line. Target resolution times are goals, not guarantees."],
    ];
    clauses(w, T);
    w.table(
      [100, 150, 150, 104],
      [
        ["Priority", "Example", "Response", "Target resolution"],
        ["P1 – Critical", "Site-wide outage", "30 minutes", "4 hours"],
        ["P2 – High", "Server or VPN down", "1 hour", "8 hours"],
        ["P3 – Normal", "Single user issue", "4 business hours", "2 business days"],
        ["P4 – Request", "New user, change", "1 business day", "5 business days"],
      ],
      { header: true, rowH: 16, size: 8.5 },
    );
    const T2 = [
      ["Service credits.", "If Northgate misses the P1 response time more than twice in a calendar month, Customer is entitled to a credit of 5% of that month's fee for each additional miss, up to 25% of the monthly fee. Credits are Customer's sole remedy for missed service levels and must be requested within thirty (30) days."],
      ["Customer responsibilities.", "Customer will maintain vendor-supported hardware and software, keep valid licenses for all software Northgate manages, designate authorized contacts who may request changes, and promptly tell Northgate of any security incident it becomes aware of. Customer remains responsible for decisions about its own data, users and business processes."],
      ["Security.", "Northgate will maintain a written information security program with administrative, technical and physical safeguards appropriate to the Services, including multi-factor authentication on all Northgate administrative access, background checks for technicians, and annual security awareness training for its staff. Northgate will notify Customer without undue delay, and in any event within seventy-two (72) hours, after confirming a security incident affecting Customer data."],
      ["Backups.", "Where backup management is included, Northgate will monitor scheduled backup jobs, investigate failures, and perform a test restore of a sample file set each quarter. Northgate does not guarantee the recoverability of data that was not included in the backup scope Customer approved."],
      ["Third-party products.", "Northgate may resell or administer third-party software and cloud subscriptions. Those products are subject to the vendor's own terms, which Customer accepts by using them. Northgate passes through any vendor warranties but gives none of its own for third-party products."],
      ["Fees and payment.", "The monthly fee is invoiced in advance on the first day of each month. Per-user charges above the covered user count are invoiced in arrears. Invoices are due net fifteen (15) days. Northgate may increase fees once per year on sixty (60) days' notice by no more than the greater of 5% or the change in CPI-U. Northgate may suspend non-critical Services if an invoice is more than thirty (30) days overdue."],
      ["Term and renewal.", "The Agreement starts on the service start date and continues for the initial term, then renews for successive one-year terms unless either party gives notice of non-renewal at least sixty (60) days before the end of the current term. Customer may terminate for convenience during the initial term by paying an early termination fee equal to 50% of the fees for the remainder of the initial term."],
      ["Transition.", "On expiry or termination Northgate will provide reasonable transition assistance for up to thirty (30) days, return Customer credentials and documentation, and remove its monitoring agents. Transition work beyond four hours is billed at time-and-materials rates."],
      ["Non-solicitation.", "During the term and for twelve (12) months afterward, Customer will not hire any Northgate technician who worked on Customer's account without paying a placement fee equal to 30% of that technician's first-year base salary."],
      ["Confidentiality.", "Each party will protect the other's confidential information with reasonable care, use it only to perform or receive the Services, and disclose it only to personnel and contractors who need to know it and are bound by written confidentiality duties. Credentials and network documentation are Customer confidential information."],
      ["Warranty and disclaimer.", "Northgate warrants that it will perform the Services in a workmanlike manner consistent with industry practice. Except for that warranty, the Services are provided as is, and Northgate disclaims all implied warranties, including merchantability and fitness for a particular purpose. Northgate does not warrant that the Services will prevent all security incidents."],
      ["Limitation of liability.", "Neither party is liable for indirect, special, incidental or consequential damages, lost profits or lost data. Each party's total liability under the Agreement is limited to the fees paid in the twelve (12) months before the claim. These limits do not apply to Customer's payment obligations or to a party's breach of confidentiality."],
      ["Insurance.", "Northgate will carry technology errors and omissions and cyber liability insurance of at least $2,000,000 per claim and commercial general liability insurance of at least $1,000,000 per occurrence."],
      ["Force majeure.", "Neither party is liable for delay caused by events beyond its reasonable control, including utility or carrier failures, natural disasters, war, labor disputes and acts of government, other than payment obligations."],
      ["Governing law.", "The Agreement is governed by the laws of the State of Ohio. The parties submit to the jurisdiction of the state and federal courts located in Franklin County, Ohio."],
      ["Entire agreement.", "The Order Form and these Terms are the entire agreement between the parties about the Services and supersede any proposals or purchase order terms. If the Order Form conflicts with these Terms, the Order Form controls. Amendments must be in writing and signed by both parties."],
    ];
    clauses(w, T2, { start: 4 });
    w.newPage();
    w.title("EXHIBIT A – SERVICE MATRIX", 12, 6);
    const Y = "Included";
    const N = "–";
    w.table(
      [200, 101, 101, 102],
      [
        ["Service", "Essentials", "Professional", "Enterprise"],
        ["Remote help desk", "Business hours", "Business hours", "24x7"],
        ["On-site support", N, "Next business day", "Same day (P1/P2)"],
        ["Patch management (OS + 3rd party)", Y, Y, Y],
        ["Endpoint detection and response", Y, Y, Y],
        ["Email security and filtering", Y, Y, Y],
        ["Backup monitoring and test restores", N, "Quarterly", "Monthly"],
        ["Microsoft 365 / Google admin", "Basic", Y, Y],
        ["Network device management", N, Y, Y],
        ["Vendor management", N, Y, Y],
        ["Security awareness training", N, "Annual", "Quarterly"],
        ["Phishing simulations", N, N, "Monthly"],
        ["Quarterly business reviews", N, Y, Y],
        ["Virtual CIO / IT roadmap", N, N, Y],
        ["Annual security assessment", N, N, Y],
        ["After-hours change windows", "Billable", "2 per month", "Unlimited"],
        ["Additional users (per user/month)", "$95", "$135", "$175"],
      ],
      { header: true, rowH: 18, size: 8.5 },
    );
    w.para("Devices: covered users may each have up to two endpoints (one computer and one mobile device). Servers, firewalls and switches listed in the onboarding inventory are covered at the tier selected; additional servers are billed at $225 per server per month.");
    w.para("Projects such as office moves, server replacements, cloud migrations and new site build-outs are outside the monthly fee and are quoted separately in a project statement of work.");
    w.newPage();
    w.title("EXHIBIT B – ACCEPTABLE USE AND SECURITY REQUIREMENTS", 12, 6);
    const AU = [
      ["Authorized contacts.", "Only the contacts Customer designates in Northgate's portal may approve changes, purchases or access requests. Northgate will verify the identity of any caller requesting a password reset or access change by a call-back to the number on file."],
      ["Multi-factor authentication.", "Customer will require multi-factor authentication for all users on email, remote access and administrative accounts. Northgate is not responsible for incidents that would have been prevented by multi-factor authentication Customer declined to enable."],
      ["Supported systems.", "Customer will replace operating systems, firewalls and other devices within twelve (12) months after the manufacturer ends security support. Unsupported systems are serviced on a reasonable-efforts basis only and are excluded from service levels."],
      ["Prohibited use.", "Customer will not use the Services or Northgate-managed systems to store or transmit unlawful material, infringe the rights of others, send unsolicited bulk email, or attempt to gain unauthorized access to any system or network."],
      ["Monitoring.", "Customer authorizes Northgate to monitor, log and inspect activity on managed systems as needed to deliver the Services, detect threats and respond to incidents, and confirms that it has given any notices to its users that applicable law requires."],
      ["Incident response.", "If Northgate detects a likely compromise, it may isolate affected devices or disable affected accounts without prior notice, and will contact Customer's authorized contacts as soon as practicable. Incident response beyond eight (8) hours per incident is billed at time-and-materials rates for Essentials and Professional tiers."],
      ["Cyber insurance.", "Customer is encouraged to maintain its own cyber insurance. On request, Northgate will provide reasonable information about its controls to support Customer's insurance applications."],
      ["Changes to these requirements.", "Northgate may update this Exhibit on thirty (30) days' notice to reflect changes in security practice. Material changes that increase Customer's costs require Customer's written agreement."],
    ];
    clauses(w, AU);
  },
);

// ================================================================= H06 photography / creative services
await holdout(
  "h06-photography-contract",
  {
    firmName: "Juniper Lane Photography LLC",
    description:
      "Letter, Helvetica 10.5. Wedding photography contract: event details as 'Label: ____' single items two per row, two '[ ]' model-release choices, and 'Signed: ________ on ________' lines (signature + date in ONE text item) under CLIENT and PHOTOGRAPHER headings, plus a client 'Print name:' line.",
    pageRange: [2, 2],
  },
  { font: "Helvetica", fontSize: 10.5, pageSize: LETTER, margin: 66, leading: 1.38, footer: pageOfN("Juniper Lane Photography  ·  ", 8) },
  (w) => {
    const t1 = "Juniper Lane";
    w.text(t1, (w.W - w.wid(t1, { size: 22, font: w.italic })) / 2, w.y + 22, { size: 22, font: w.italic });
    const t2 = "P H O T O G R A P H Y";
    w.text(t2, (w.W - w.wid(t2, { size: 8 })) / 2, w.y + 36, { size: 8, color: GREY });
    w.y += 54;
    w.title("Wedding Photography Agreement", 14, 6);
    w.para(
      `This agreement is between Juniper Lane Photography LLC ("Photographer," "we," "us") and the client(s) named below ("Client," "you"). Your date is reserved once we receive this signed agreement and the retainer.`,
    );
    w.heading("Event Details", { size: 11.5 });
    const colW = (w.textW - 24) / 2;
    const pairs = [
      [["Client name(s):", "name"], ["Email:", "email"]],
      [["Event date:", "date"], ["Venue:", "text"]],
      [["Coverage hours:", "text"], ["Package:", "text"]],
      [["Total fee: $", "text"], ["Retainer due: $", "text"]],
    ];
    for (const row of pairs) {
      const base = w.y + 10.5;
      row.forEach(([label, type], i) => {
        const x = w.m + i * (colW + 24);
        if (label.endsWith("$")) {
          // "$" hugs the blank
          const pre = label;
          const lw = w.wid(pre);
          const n = w.nUnders(colW - lw);
          const u = "_".repeat(n);
          w.text(pre + u, x, base);
          w.onLine({ type, role: "prefill", note: label }, x + lw, base + 2, w.wid(u));
        } else w.labeled(label, x, base, colW, { type, role: "prefill", note: label });
      });
      w.y += 24;
    }
    w.advance(6);
    const T = [
      ["Retainer.", "A non-refundable retainer is due when you sign. It reserves your date and is applied to the total fee. The balance is due fourteen (14) days before the event date."],
      ["Coverage.", "We will photograph the event for the coverage hours above, beginning at the time you confirm in our planning questionnaire. Additional coverage on the day is billed at $250 per hour, in half-hour increments, and is payable within seven days after the event."],
      ["Delivery.", "You will receive an online gallery of edited, high-resolution images within eight (8) weeks after the event. We select and edit images using our professional judgment; unedited files are not delivered. Galleries remain online for twelve (12) months."],
      ["Copyright and license.", "Photographer owns the copyright in all images. You receive a personal, non-exclusive license to print, share and display the images for personal use. Commercial use, or sale of the images to third parties, requires our written permission."],
    ];
    clauses(w, T);
    w.rich(
      [
        "We would love to share some of your images in our portfolio, on our website and on social media. Please tick one option:",
      ],
      { lead: "5. Model release.", after: 6 },
    );
    for (const t of ["You may use our images for portfolio and marketing purposes.", "Please do not use our images publicly."]) {
      const b = w.y + 10.5;
      w.bracket(w.m + 18, b, t, { role: "client", note: t.slice(0, 30) });
      w.y += 20;
    }
    w.advance(4);
    const T2 = [
      ["Cancellation and rescheduling.", "If you cancel, the retainer is kept and any further payments made are refunded less expenses already incurred. If you reschedule to a date we have open within eighteen (18) months, we will transfer the retainer once."],
      ["Meals and breaks.", "For coverage of six hours or more, you agree to provide a meal for the photographer and any assistant at the same time as your guests are served, and a short break."],
      ["Limitation of liability.", "We use professional equipment and back up images on two cards during the event. If images are lost, damaged or not delivered for reasons within or beyond our control, our liability is limited to a refund of the amounts you have paid. We are not responsible for images missed because of guest interference, venue restrictions, weather or schedule changes."],
      ["Substitute photographer.", "If illness or emergency prevents the lead photographer from attending, we will make every effort to send a qualified substitute of comparable style. If no substitute is available, we will refund all amounts paid."],
    ];
    clauses(w, T2, { start: 6 });
    w.ensure(200);
    w.advance(12);
    let base = w.y + 10.5;
    const signed = (x, b, sw, dw, sigField, dateField) => {
      const a = "Signed: ";
      const u1 = "_".repeat(w.nUnders(sw));
      const mid = " on ";
      const u2 = "_".repeat(w.nUnders(dw));
      w.text(a + u1 + mid + u2, x, b);
      w.onLine(sigField, x + w.wid(a), b + 2, w.wid(u1));
      w.onLine(dateField, x + w.wid(a + u1 + mid), b + 2, w.wid(u2));
    };
    w.text("CLIENT", w.m, base, { font: w.bold });
    base += 34;
    signed(w.m, base, 230, 110, { type: "signature", role: "client", note: "CLIENT Signed: ____" }, { type: "date", role: "client", note: "CLIENT on ____" });
    base += 28;
    w.labeled("Print name:", w.m, base, 280, { type: "name", role: "client", note: "CLIENT Print name" });
    base += 44;
    w.text("PHOTOGRAPHER", w.m, base, { font: w.bold });
    w.text("  for Juniper Lane Photography LLC", w.m + w.wid("PHOTOGRAPHER", { font: w.bold }), base);
    base += 34;
    signed(w.m, base, 230, 110, { type: "signature", role: "firm", note: "PHOTOGRAPHER Signed: ____" }, { type: "date", role: "firm", note: "PHOTOGRAPHER on ____" });
    w.y = base + 20;
  },
);

// ================================================================= H07 law-firm retainer with fee table
await holdout(
  "h07-law-firm-retainer",
  {
    firmName: "Ashcombe Whitlow LLP",
    description:
      "Letter, TimesRoman 11.5. Law-firm engagement letter: date / salutation / matter blanks, hourly-rate table, trust-deposit blank, 'Client's initials: ____' after the fee-arbitration clause, firm signs 'By: ____' under 'Very truly yours, ASHCOMBE WHITLOW LLP' with partner name printed below, then 'CLIENT ACKNOWLEDGMENT' with drawn lines and captions under ('Signature of Client', 'Date', 'Printed name', 'On behalf of (if an entity)').",
    pageRange: [3, 3],
  },
  { font: "TimesRoman", fontSize: 11.5, pageSize: LETTER, margin: 72, leading: 1.4, footer: pageOfN("", 8.5) },
  (w) => {
    const h = "ASHCOMBE WHITLOW LLP";
    w.text(h, (w.W - w.wid(h, { size: 13, font: w.bold })) / 2, w.y + 13, { size: 13, font: w.bold });
    const s = "Attorneys at Law  |  00 Example Street, 0th Floor  |  Anytown, ST 00000";
    w.text(s, (w.W - w.wid(s, { size: 8.5 })) / 2, w.y + 26, { size: 8.5, color: GREY });
    w.y += 48;
    w.text("PRIVILEGED & CONFIDENTIAL", w.m, w.y + 10, { size: 9.5, font: w.bold });
    w.y += 24;
    w.rich([{ blank: 130, field: { type: "date", role: "prefill", note: "letter date" } }], { after: 10 });
    w.rich(["Re:  Engagement Letter and Fee Agreement – ", { blank: 180, field: { type: "text", role: "prefill", note: "Re: matter ____" } }], { font: w.bold, after: 10 });
    w.rich(["Dear ", { blank: 140, field: { type: "name", role: "prefill", note: "Dear ____:" } }, ":"], { after: 10 });
    w.para(
      `Thank you for selecting Ashcombe Whitlow LLP ("the Firm," "we," "us") to represent you ("you" or "Client") in the matter referenced above. This letter sets out the scope of our engagement and the basis on which we will charge for our services. Professional rules require that we put these terms in writing, and we find it helps both of us to have a clear understanding from the start.`,
    );
    const T = [
      ["Scope of engagement.", "We will represent you in the matter described above, including investigation, negotiation, and, if necessary, litigation through trial in the court of first instance. Our engagement does not include appeals, enforcement of any judgment, tax advice, or any other matter unless we agree in writing to expand it."],
      ["Staffing.", "Rowan Fakely will be the partner responsible for your matter. Associates, paralegals and other partners may work on the matter where that is efficient. We will try to staff the matter at the lowest rate consistent with the quality the work requires."],
      ["Fees.", "Our fees are based on the time spent on your matter, recorded in increments of one-tenth of an hour, at the hourly rates below. Rates are typically adjusted on January 1 of each year, and we will notify you of any change at least thirty days in advance."],
    ];
    clauses(w, T);
    w.table(
      [260, 208],
      [
        ["Timekeeper", "Hourly rate"],
        ["Partners", "$595"],
        ["Senior associates", "$425"],
        ["Associates", "$345"],
        ["Paralegals", "$185"],
      ],
      { header: true, rowH: 18, size: 10.5 },
    );
    w.rich(
      [
        "Before we begin work you agree to deposit $",
        { blank: 80, field: { type: "text", role: "prefill", note: "deposit $____" } },
        " into our client trust account. We will apply the deposit to our final invoice and will refund any unused balance at the end of the engagement. We may ask you to replenish the deposit if our fees and costs are expected to exceed it.",
      ],
      { lead: "4. Retainer deposit." },
    );
    const T2 = [
      ["Costs.", "In addition to our fees, you agree to pay the costs we incur on your behalf, such as court filing fees, deposition transcripts, expert witness fees, travel and courier charges. We will ask for your approval before incurring any single cost greater than $1,000."],
      ["Billing and payment.", "We will send you a detailed invoice each month showing the work performed, the timekeeper, the time spent and the costs incurred. Payment is due within thirty (30) days. If invoices are not paid when due, we may withdraw from the representation, subject to court approval where required."],
      ["No guarantee.", "We will give you our best professional judgment, but we cannot guarantee the outcome of your matter. Any statement about likely outcomes is an expression of opinion only."],
      ["Conflicts of interest.", "We have searched our records based on the names you gave us and found no conflict of interest. Please tell us promptly if you learn of any other party with an interest in the matter so that we can update our search."],
      ["Termination.", "You may end our engagement at any time by written notice. We may withdraw for good cause, including non-payment or your failure to cooperate, subject to our ethical obligations. Fees and costs incurred before termination remain payable."],
      ["File retention.", "At the end of the engagement we will return any original documents you gave us. We will keep our file for seven (7) years, after which it may be destroyed without further notice unless you ask for it in writing before then."],
      ["Fee disputes.", "If a dispute arises about our fees or costs, you may have the right to arbitration under the state bar's mandatory fee arbitration program. If you do not use that program, you and the Firm agree that any fee dispute will be resolved by binding arbitration, and both of us give up the right to a jury trial on that dispute."],
    ];
    clauses(w, T2, { start: 5 });
    {
      w.ensure(24);
      const b = w.y + 11.5;
      const lx = w.text("Client's initials:", w.W - w.m - 160, b);
      w.blank(lx + 5, b, 60, { type: "initials", role: "client", note: "Client's initials (arbitration)" });
      w.y += 26;
    }
    w.para(
      "If these terms are acceptable, please sign the acknowledgment below and return a copy to us with the retainer deposit. If we do not receive the signed letter within thirty days, we will assume you have decided not to engage us. We look forward to working with you.",
    );
    w.ensure(130);
    let base = w.y + 11.5;
    w.text("Very truly yours,", w.m, base);
    base += 20;
    w.text("ASHCOMBE WHITLOW LLP", w.m, base, { font: w.bold });
    base += 36;
    w.labeled("By:", w.m, base, 240, { type: "signature", role: "firm", note: "firm By:" });
    base += 15;
    w.text("Rowan Fakely, Partner", w.m + w.wid("By: "), base, { size: 10.5 });
    w.y = base + 30;
    w.ensure(210);
    base = w.y + 12;
    w.text("CLIENT ACKNOWLEDGMENT", w.m, base, { font: w.bold, size: 12 });
    w.y = base + 8;
    w.para("I have read and understand this engagement letter, I have had the opportunity to ask questions about it, and I agree to its terms.");
    base = w.y + 36;
    const cap = (x0, x1, b, field, caption) => {
      w.hline(x0, x1, b + 2);
      w.onLine(field, x0, b + 2, x1 - x0);
      w.text(caption, x0, b + 14, { size: 9, font: w.italic });
    };
    cap(w.m, w.m + 260, base, { type: "signature", role: "client", note: "Signature of Client" }, "Signature of Client");
    cap(w.m + 300, w.m + 450, base, { type: "date", role: "client", note: "Date" }, "Date");
    base += 44;
    cap(w.m, w.m + 260, base, { type: "name", role: "client", note: "Printed name" }, "Printed name");
    base += 44;
    cap(w.m, w.m + 260, base, { type: "company", role: "client", acceptRoles: ["prefill"], acceptTypes: ["name"], note: "On behalf of (if an entity)" }, "On behalf of (if an entity)");
    w.y = base + 24;
  },
);

// ================================================================= H08 consulting NDA + engagement (AU)
await holdout(
  "h08-consulting-nda-engagement",
  {
    firmName: "Kestrel Ridge Consulting Pty Ltd",
    description:
      "A4, TimesRoman 10. Australian combined confidentiality + consulting engagement deed: 'Parties' block with blanks for client name / ABN / address, Part A (confidentiality) and Part B (engagement), a Schedule with item blanks, then 'EXECUTED as an agreement' with two columns headed 'For and on behalf of / Kestrel Ridge Consulting Pty Ltd' and 'For and on behalf of / the Client'; each line is a row of dot leaders with an italic caption UNDER it ('Signature of authorised person', 'Name of authorised person (print)', 'Office held', 'Date').",
    pageRange: [2, 2],
  },
  { font: "TimesRoman", fontSize: 10, pageSize: A4, margin: 62, leading: 1.38, footer: pageOfN("Kestrel Ridge Consulting – Confidentiality and Engagement Agreement – ", 7.5) },
  (w) => {
    w.title("CONFIDENTIALITY AND CONSULTING ENGAGEMENT AGREEMENT", 13, 8);
    w.heading("Parties", { size: 10.5 });
    w.rich(
      [
        `1.  Kestrel Ridge Consulting Pty Ltd ACN 000 000 000 of Level 0, 00 Example Street, Sydney NSW 0000 ("Kestrel" or "Consultant").`,
      ],
      { indent: 10 },
    );
    w.rich(
      [
        "2.  ",
        { blank: 150, field: { type: "company", role: "prefill", acceptTypes: ["name"], note: "Parties 2 / client name" } },
        " ABN ",
        { blank: 90, field: { type: "text", role: "prefill", acceptRoles: ["client"], note: "Parties 2 / ABN" } },
        " of ",
        { blank: 150, field: { type: "text", role: "prefill", acceptRoles: ["client"], note: "Parties 2 / address" } },
        ` ("Client").`,
      ],
      { indent: 10, oneItem: true },
    );
    w.heading("Background", { size: 10.5 });
    w.para("A.  The Client wishes to engage the Consultant to provide operational and strategy consulting services, and the parties expect to exchange confidential information for that purpose.", { indent: 10 });
    w.para("B.  The parties have agreed to protect that information on the terms in Part A, and that the Consultant will provide the services on the terms in Part B.", { indent: 10 });
    w.heading("PART A – CONFIDENTIALITY", { size: 10.5, before: 8 });
    const A = [
      ["Confidential Information.", `"Confidential Information" means all information disclosed by or on behalf of a party (the "Discloser") to the other party (the "Recipient") in connection with this agreement, whether before or after its date and in any form, including information about the Discloser's customers, pricing, finances, personnel, systems and business plans, but excluding information that is in the public domain other than through a breach of this agreement, or that the Recipient can show it lawfully held before disclosure.`],
      ["Obligations.", "The Recipient must keep the Discloser's Confidential Information confidential, use it only for the purpose of this agreement, and not disclose it except to its officers, employees and professional advisers who need to know it and are bound by obligations of confidence no less strict than these. The Recipient is responsible for any breach by those people."],
      ["Required disclosure.", "The Recipient may disclose Confidential Information to the extent required by law or the listing rules of a stock exchange, provided it gives the Discloser as much notice as is reasonably practicable and co-operates with any lawful attempt to limit the disclosure."],
      ["Return and destruction.", "On request, and in any event when this agreement ends, the Recipient must return or destroy the Discloser's Confidential Information in its possession, except copies held in automatic back-up systems or required to be retained by law, which remain subject to this Part A."],
      ["Duration.", "The obligations in this Part A continue for five (5) years after this agreement ends, and indefinitely for trade secrets."],
    ];
    clauses(w, A);
    w.heading("PART B – CONSULTING ENGAGEMENT", { size: 10.5, before: 8 });
    const B = [
      ["Services.", "The Consultant will provide the services described in Item 1 of the Schedule (the \"Services\") from the commencement date in Item 2, with due care and skill and in accordance with the Client's reasonable directions."],
      ["Fees.", "The Client must pay the fees in Item 3 of the Schedule, plus GST. The Consultant will invoice fortnightly in arrears and the Client must pay each correct tax invoice within fourteen (14) days of receipt. Pre-approved travel and accommodation outside the Sydney metropolitan area are reimbursed at cost."],
      ["Client representative.", "The person named in Item 4 of the Schedule is authorised to give directions and approvals on the Client's behalf. The Client may change its representative by written notice."],
      ["Intellectual property.", "Reports and other deliverables prepared specifically for the Client vest in the Client on payment. The Consultant retains its methods, frameworks, templates and know-how, and grants the Client a perpetual licence to use any of them embedded in a deliverable for the Client's internal purposes."],
      ["Personnel.", "The Consultant will perform the Services using the personnel it nominates. The Client may, acting reasonably, ask for any person to be replaced, and the Consultant will do so as soon as practicable at no extra cost."],
      ["Liability.", "To the extent permitted by law, including the Australian Consumer Law, each party's liability under this agreement is limited to the total fees paid or payable under it, and neither party is liable for indirect or consequential loss. This limit does not apply to a breach of Part A."],
      ["Termination.", "Either party may terminate the engagement on twenty (20) business days' written notice, or immediately if the other party commits a material breach that is not remedied within ten (10) business days of notice. Part A and clauses 9 and 11 survive termination."],
      ["General.", "This agreement is governed by the laws of New South Wales. It may be executed in counterparts and by electronic signature. It is the entire agreement between the parties on its subject matter."],
    ];
    clauses(w, B, { start: 6 });
    w.ensure(130);
    w.heading("SCHEDULE", { size: 10.5, before: 8 });
    const items = [
      ["Item 1 – Services", "As described in Consultant proposal reference ", { type: "text", note: "Item 1 proposal ref ____" }, 110],
      ["Item 2 – Commencement date", "", { type: "date", note: "Item 2 commencement date" }, 130],
      ["Item 3 – Fees", "A$", { type: "text", note: "Item 3 fees A$____" }, 70, " per consultant day, excluding GST"],
      ["Item 4 – Client representative", "", { type: "name", note: "Item 4 client representative", acceptRoles: ["client"] }, 170],
    ];
    for (const [label, pre, field, bw, post] of items) {
      w.ensure(20);
      const b = w.y + 10;
      w.text(label, w.m, b, { font: w.bold });
      let x = w.m + 150;
      if (pre) x = w.text(pre, x, b) + (pre.endsWith(" ") ? 0 : 1);
      x = w.blank(x, b, bw, { role: "prefill", ...field });
      if (post) w.text(post, x, b);
      w.y += 20;
    }
    w.advance(12);
    w.ensure(260);
    w.text("EXECUTED as an agreement.", w.m, w.y + 10, { font: w.bold });
    w.y += 26;
    const gap = 34;
    const colW = (w.textW - gap) / 2;
    const heads = [
      ["For and on behalf of", "Kestrel Ridge Consulting Pty Ltd", "firm"],
      ["For and on behalf of", "the Client", "client"],
    ];
    let hb = w.y + 10;
    heads.forEach(([a, b], i) => {
      const x = w.m + i * (colW + gap);
      w.text(a, x, hb);
      w.text(b, x, hb + 13, { font: w.bold });
    });
    let base = hb + 13;
    const dw = w.wid(".");
    const nd = Math.floor(colW / dw);
    const dots = ".".repeat(nd);
    for (const [cap, type] of [
      ["Signature of authorised person", "signature"],
      ["Name of authorised person (print)", "name"],
      ["Office held", "title"],
      ["Date", "date"],
    ]) {
      base += type === "signature" ? 44 : 34;
      heads.forEach(([, b, role], i) => {
        const x = w.m + i * (colW + gap);
        w.text(dots, x, base);
        w.onLine({ type, role, note: `${b} / ${cap}` }, x, base + 2, w.wid(dots));
        w.text(cap, x, base + 11, { size: 8, font: w.italic });
      });
    }
    w.y = base + 24;
  },
);

// ================================================================= H09 coaching agreement
await holdout(
  "h09-coaching-agreement",
  {
    firmName: "Willowmere Coaching LLC",
    description:
      "Letter, Helvetica 11. Individual executive-coaching agreement ('Coach'/'Client', 'we'/'you'): client name blank in the preamble, start date and investment blanks in a program summary, two '[ ]' payment options on ONE line, then a 'Client acknowledgment' paragraph and two side-by-side columns (COACH left, CLIENT right) of drawn lines with captions under. Coach's printed name is already typed (no field).",
    pageRange: [2, 2],
  },
  { font: "Helvetica", fontSize: 11, pageSize: LETTER, margin: 72, leading: 1.42, footer: pageOfN("Willowmere Coaching  ·  ", 8) },
  (w) => {
    w.title("COACHING AGREEMENT", 15, 10);
    w.rich([
      `This Coaching Agreement is between Willowmere Coaching LLC ("Coach," "we") and `,
      { blank: 160, field: { type: "name", role: "prefill", note: 'and ____ ("Client")' } },
      ` ("Client," "you"). It describes how we will work together.`,
    ]);
    w.heading("Program Summary", { size: 12 });
    const rows = [
      ["Program", "Executive Leadership Intensive"],
      ["Sessions", "Twelve (12) 60-minute video sessions"],
      ["Start date", { type: "date", note: "Start date" }],
      ["Investment", { type: "text", note: "Investment $____", dollar: true }],
    ];
    for (const [k, v] of rows) {
      const b = w.y + 11;
      w.text(k, w.m + 10, b, { font: w.bold });
      const x = w.m + 110;
      if (typeof v === "string") w.text(v, x, b);
      else {
        let bx = x;
        if (v.dollar) bx = w.text("$", x, b);
        w.blank(bx, b, 120, { type: v.type, role: "prefill", note: v.note });
      }
      w.y += 21;
    }
    w.advance(4);
    w.para("Payment option (please tick one):", { after: 4 });
    {
      const b = w.y + 11;
      const x = w.bracket(w.m + 10, b, "Paid in full at signing", { role: "client", note: "Paid in full" });
      w.bracket(x + 36, b, "Three monthly installments", { role: "client", note: "Three monthly installments" });
      w.y += 24;
    }
    const T = [
      ["Nature of coaching.", "Coaching is a partnership focused on your professional goals. It is not therapy, counseling, legal or financial advice, and it is not a substitute for those services. You are responsible for your own decisions and results, and we do not promise any particular outcome."],
      ["Confidentiality.", "We keep what you share in our sessions confidential, except where disclosure is required by law or where we believe there is a risk of serious harm to you or others. If your employer is paying for the program, we will report only attendance and the goals you agree we may share."],
      ["Scheduling and cancellation.", "Sessions are booked through our online scheduler. You may reschedule a session up to 24 hours in advance at no charge. Sessions cancelled or missed with less than 24 hours' notice are counted as used. All twelve sessions must be used within nine months of the start date."],
      ["Payment.", "If you choose installments, the first is due at signing and the others on the same day of each of the next two months, charged to the card on file. A late installment pauses scheduling until it is paid."],
      ["Refunds.", "If you decide coaching is not right for you after the first session, tell us before the second session and we will refund the investment less one session at our standard rate of $450. After the second session, payments are non-refundable."],
      ["Recording.", "We do not record sessions unless you ask us to in writing. Any recording is shared only with you and deleted after thirty days."],
      ["Ending the agreement.", "Either of us may end this agreement by email if the coaching relationship is no longer useful. Any unused prepaid sessions after the refund period are refunded at a pro-rated amount of the investment."],
    ];
    clauses(w, T);
    w.ensure(230);
    w.advance(6);
    w.heading("Client acknowledgment", { size: 12 });
    w.para("By signing, you confirm that you have read this agreement, understand that coaching is not therapy, and agree to the terms above.");
    const gap = 40;
    const colW = (w.textW - gap) / 2;
    const L = w.m;
    const R = w.m + colW + gap;
    let base = w.y + 11;
    w.text("COACH", L, base, { font: w.bold });
    w.text("CLIENT", R, base, { font: w.bold });
    const cap = (x, b, field, caption) => {
      w.hline(x, x + colW, b + 2);
      if (field) w.onLine(field, x, b + 2, colW);
      w.text(caption, x, b + 14, { size: 8.5, color: GREY });
    };
    base += 42;
    cap(L, base, { type: "signature", role: "firm", note: "COACH Signature" }, "Signature");
    cap(R, base, { type: "signature", role: "client", note: "CLIENT Signature" }, "Signature");
    base += 40;
    w.text("Avery Fakesmith, PCC – Founder", L, base);
    w.hline(L, L + colW, base + 2);
    w.text("Printed name", L, base + 14, { size: 8.5, color: GREY });
    cap(R, base, { type: "name", role: "client", note: "CLIENT Printed name" }, "Printed name");
    base += 40;
    cap(L, base, { type: "date", role: "firm", note: "COACH Date" }, "Date");
    cap(R, base, { type: "date", role: "client", note: "CLIENT Date" }, "Date");
    w.y = base + 24;
  },
);

console.log(`wrote ${written.length} holdout fixtures to ${path.relative(ROOT, OUT)}/`);
for (const s of written) console.log("  " + s);
