import { PDFDocument, StandardFonts, rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import { clauseLabel, type DraftDocument } from "./types";
import { DraftValidationError, LIMITS, oneLine, prepareDraft } from "./validate";
import { pdfEquivalents } from "./pdf-text";

// US Letter, 1" side margins; the bottom margin leaves room for the footer (title and "Page X of N").
const W = 612, H = 792, M = 72, TOP = 66, BOTTOM = 78;
const BODY = 10.5, LEAD = 14.5, HEAD = 11.5, TITLE = 19, LABEL = 7.5;
const INK = rgb(0.09, 0.11, 0.15), MUTED = rgb(0.42, 0.45, 0.5), RULE = rgb(0.8, 0.82, 0.86), ACCENT = rgb(0.12, 0.23, 0.5);
/** A list item line in a clause ("(a) Data analytics consulting"): drawn with a hanging indent. */
const ITEM = /^\(([a-z])\)\s+/;

// Standard fonts only encode WinAnsi. Typographic characters with a WinAnsi equivalent print as that (pdf-text.ts);
// anything else is replaced with "?" so rendering never throws (and is visible, not silently dropped). Callers
// refuse such documents first with pdfTextProblem.
function winAnsi(s: string, font: PDFFont): string {
  const t = pdfEquivalents(s).replace(/\t/g, "    ");
  try {
    font.encodeText(t); // fast path: whole string encodes, so nothing to replace
    return t;
  } catch {
    // slow path: replace unencodable code points, checking each distinct one only once
    const ok = new Map<string, boolean>();
    let out = "";
    for (const ch of t) {
      let good = ok.get(ch);
      if (good === undefined) {
        try { font.encodeText(ch); good = true; } catch { good = false; }
        ok.set(ch, good);
      }
      out += good ? ch : "?";
    }
    return out;
  }
}

export async function renderPdf(input: DraftDocument): Promise<Uint8Array> {
  const doc = prepareDraft(input);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const epoch = new Date(0);
  pdf.setTitle(doc.title);
  pdf.setAuthor("doc-output");
  pdf.setCreator("doc-output");
  pdf.setProducer("doc-output");
  pdf.setSubject("");
  pdf.setKeywords([]);
  pdf.setCreationDate(epoch);
  pdf.setModificationDate(epoch);
  // a serif body for reading, a sans for small labels and the footer
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - TOP;
  let pages = 1;
  const newPage = () => {
    if (++pages > LIMITS.maxPages) throw new DraftValidationError(`document is longer than ${LIMITS.maxPages} pages`, "too_large");
    page = pdf.addPage([W, H]);
    y = H - TOP;
  };
  let dry = false; // dry run: measure layout height without drawing or paginating
  const ensure = (h: number) => { if (!dry && y - h < BOTTOM) newPage(); };
  const eol = (t: string) => t.replace(/\r\n|\r/g, "\n");
  const one = oneLine; // single-line fields (prepareDraft has already flattened the input ones)
  const TEXT_W = W - 2 * M;

  // Greedy word wrap to `max` points; a single word wider than the line is hard-broken at the line width.
  function wrap(text: string, f: PDFFont, size: number, max = TEXT_W): string[] {
    const t = winAnsi(text, f);
    const fits = (s: string) => f.widthOfTextAtSize(s, size) <= max;
    // Longest prefix of s.slice(from) that fits (at least one character). Exponential then binary search over
    // prefix lengths: each probe is at most twice the fitting length, so breaking an n-character word costs
    // O(n log n) width work instead of the old cubic shrink-by-one loop.
    const fitLen = (s: string, from: number): number => {
      const rest = s.length - from;
      let good = 1;
      let bad = 0;
      for (let probe = 1; probe < rest; ) {
        probe = Math.min(probe * 2, rest);
        if (fits(s.slice(from, from + probe))) good = probe;
        else { bad = probe; break; }
      }
      if (!bad) return good;
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (fits(s.slice(from, from + mid))) good = mid;
        else bad = mid;
      }
      return good;
    };
    const lines: string[] = [];
    let cur = "";
    for (const word of t.split(" ")) {
      let w = word;
      if (!fits(w)) {
        if (cur) { lines.push(cur); cur = ""; }
        let i = 0;
        for (;;) {
          const n = fitLen(w, i);
          if (i + n >= w.length) break;
          lines.push(w.slice(i, i + n));
          i += n;
        }
        w = w.slice(i);
      }
      const trial = cur ? `${cur} ${w}` : w;
      if (cur && !fits(trial)) { lines.push(cur); cur = w; } else cur = trial;
    }
    lines.push(cur);
    return lines;
  }
  type Style = { font: PDFFont; size: number; lead?: number; color?: ReturnType<typeof rgb>; x?: number; max?: number; spacing?: number; center?: boolean };
  function text(line: string, st: Style) {
    if (dry || !line) return;
    const x = st.center ? (W - st.font.widthOfTextAtSize(line, st.size) - (st.spacing ?? 0) * Math.max(0, line.length - 1)) / 2 : st.x ?? M;
    if (st.spacing) page.pushOperators(setCharacterSpacing(st.spacing));
    page.drawText(line, { x, y: y + 3, size: st.size, font: st.font, color: st.color ?? INK });
    if (st.spacing) page.pushOperators(setCharacterSpacing(0));
  }
  function draw(s: string, st: Style) {
    const lead = st.lead ?? LEAD;
    for (const line of wrap(s, st.font, st.size, st.max)) {
      ensure(lead);
      y -= lead;
      text(line, st);
    }
  }
  const rule = (x1 = M, x2 = W - M, color = RULE, thickness = 0.6) => { if (!dry) page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color }); };
  const bodyLines = (para: string) => (ITEM.test(para) ? wrap(para, serif, BODY, TEXT_W - 18).length : wrap(para, serif, BODY).length);

  // ---- title block: the agreement's name, centred, over an accent rule ----
  y -= 8;
  for (const line of wrap(one(doc.title).toUpperCase(), serifBold, TITLE, TEXT_W)) { y -= 24; text(line, { font: serifBold, size: TITLE, center: true, spacing: 1.2 }); }
  y -= 12;
  if (!dry) page.drawLine({ start: { x: W / 2 - 36, y }, end: { x: W / 2 + 36, y }, thickness: 1.4, color: ACCENT });
  y -= 18;

  // ---- parties: a two-column table (role label, legal name, defined term) ----
  if (doc.parties.length) {
    draw("Parties", { font: sansBold, size: LABEL, color: MUTED, lead: 12 });
    y -= 6;
    const colW = (TEXT_W - 24) / 2;
    for (let r = 0; r < doc.parties.length; r += 2) {
      const row = doc.parties.slice(r, r + 2);
      const cells = row.map((p) => ({ role: one(p.role), name: wrap(one(p.name), serifBold, 12.5, colW) }));
      const h = 14 + Math.max(...cells.map((c) => c.name.length)) * 16 + 16;
      ensure(h + 8);
      if (!dry) page.drawRectangle({ x: M, y: y - h, width: TEXT_W, height: h, color: rgb(0.965, 0.97, 0.98) });
      const top = y;
      cells.forEach((c, k) => {
        const x = M + 12 + k * (colW + 24);
        y = top - 14;
        // labels without letter-spacing: spaced text extracts as "P a r t i e s", which breaks search and copying
        text(c.role.toUpperCase(), { font: sansBold, size: LABEL, color: MUTED, x });
        for (const line of c.name) { y -= 16; text(line, { font: serifBold, size: 12.5, x }); }
        y -= 13;
        text(`(the \u201c${c.role}\u201d)`, { font: serif, size: 9, color: MUTED, x });
      });
      y = top - h - 10;
    }
    y -= 6;
    rule();
    y -= 6;
  }

  // ---- clauses: numbered headings kept with their first lines; list items with a hanging indent ----
  doc.clauses.forEach((c, i) => {
    const label = clauseLabel(c, i);
    const head = one(c.heading ? `${label} ${c.heading}` : label);
    const paras = eol(c.text).split("\n");
    // the first two body lines: wrapping the first paragraph is enough (a long clause isn't re-wrapped here)
    const first = Math.min(2, bodyLines(paras[0]) + (paras.length > 1 ? 1 : 0));
    ensure(wrap(head, serifBold, HEAD).length * 16 + 10 + first * LEAD); // no heading alone at the foot of a page
    y -= 10;
    draw(head, { font: serifBold, size: HEAD, lead: 16 });
    y -= 2;
    for (const para of paras) {
      const m = ITEM.exec(para);
      if (!m) { draw(para, { font: serif, size: BODY }); continue; }
      // "(a) item": the marker in the margin column, wrapped lines aligned with the item's first word
      const indent = 18;
      const lines = wrap(para, serif, BODY, TEXT_W - indent);
      const markerW = serif.widthOfTextAtSize(winAnsi(m[0], serif), BODY);
      lines.forEach((line, k) => {
        ensure(LEAD);
        y -= LEAD;
        text(line, { font: serif, size: BODY, x: M + indent + (k === 0 ? 0 : markerW) });
      });
    }
  });

  // Locked signature block: measured with a dry run, then kept together on one page when it fits on one. The
  // labels ("Signed for", "Signature", "Name:", "Date:") are what field detection reads on a published draft.
  const sigBlock = () => {
    // the same vertical geometry as before the redesign (gaps, rule position, line heights): field detection on a
    // published draft depends on it, e.g. the caption's distance from the rule merges the two into one signature field
    y -= 16;
    draw("Signatures", { font: serifBold, size: 12, lead: 15 });
    for (const p of doc.parties) {
      y -= 22;
      draw(one(`Signed for ${p.name} (${p.role})`), { font: serifBold, size: 11, lead: 15 });
      y -= 18;
      ensure(40);
      rule(M, M + 260, INK, 0.75);
      y -= 12;
      draw("Signature", { font: sans, size: 9, color: MUTED, lead: 11 });
      y -= 14;
      draw(one(`Name: ${p.name}`), { font: serif, size: 11, lead: 15 });
      draw("Date: ____________________", { font: serif, size: 11, lead: 15 });
    }
  };
  if (doc.parties.length) {
    const y0 = y;
    dry = true;
    sigBlock();
    const used = y0 - y;
    dry = false;
    y = y0;
    if (y - used < BOTTOM && used <= H - TOP - BOTTOM) newPage(); // a block taller than a page must split (very many parties)
    sigBlock();
  }

  // ---- footer on every page: the agreement's name and "Page X of N" ----
  const all = pdf.getPages();
  const footTitle = winAnsi(one(doc.title), sans);
  all.forEach((pg, k) => {
    pg.drawLine({ start: { x: M, y: 52 }, end: { x: W - M, y: 52 }, thickness: 0.5, color: RULE });
    pg.drawText(footTitle, { x: M, y: 38, size: 8, font: sans, color: MUTED });
    const num = `Page ${k + 1} of ${all.length}`;
    pg.drawText(num, { x: W - M - sans.widthOfTextAtSize(num, 8), y: 38, size: 8, font: sans, color: MUTED });
  });
  return pdf.save({ useObjectStreams: false });
}
