import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { clauseLabel, type DraftDocument } from "./types";
import { DraftValidationError, LIMITS, oneLine, prepareDraft } from "./validate";

const W = 612, H = 792, M = 72;
const BODY = 11, LEAD = 15, HEAD = 12, TITLE = 20;

// Standard fonts only encode WinAnsi. Anything else is replaced with "?" so rendering never throws
// (and is visible, not silently dropped).
function winAnsi(s: string, font: PDFFont): string {
  const t = s.replace(/\t/g, "    ");
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
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  let pages = 1;
  const newPage = () => {
    if (++pages > LIMITS.maxPages) throw new DraftValidationError(`document is longer than ${LIMITS.maxPages} pages`, "too_large");
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  let dry = false; // dry run: measure layout height without drawing or paginating
  const ensure = (h: number) => { if (!dry && y - h < M) newPage(); };
  const eol = (t: string) => t.replace(/\r\n|\r/g, "\n");
  const one = oneLine; // single-line fields (prepareDraft has already flattened the input ones)

  // Greedy word wrap; a single word wider than the line is hard-broken at the line width.
  function wrap(text: string, f: PDFFont, size: number): string[] {
    const t = winAnsi(text, f);
    const max = W - 2 * M;
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
  function draw(text: string, f: PDFFont, size: number, lead = LEAD) {
    for (const line of wrap(text, f, size)) {
      ensure(lead);
      y -= lead;
      if (line && !dry) page.drawText(line, { x: M, y: y + 3, size, font: f });
    }
  }

  draw(one(doc.title), bold, TITLE, 26);
  y -= 8;
  if (doc.parties.length) {
    draw("Parties", bold, HEAD);
    for (const p of doc.parties) draw(one(`${p.role}: ${p.name}`), font, BODY);
    y -= 8;
  }
  doc.clauses.forEach((c, i) => {
    const label = clauseLabel(c, i);
    const head = one(c.heading ? `${label} ${c.heading}` : label);
    ensure(wrap(head, bold, HEAD).length * LEAD + LEAD + 6); // keep a heading with a line of its body
    y -= 6;
    draw(head, bold, HEAD);
    for (const para of eol(c.text).split("\n")) draw(para, font, BODY);
  });

  // Locked signature block: measured with a dry run, then kept together on one page when it fits on one.
  const sigBlock = () => {
    y -= 16;
    draw("Signatures", bold, HEAD);
    for (const p of doc.parties) {
      y -= 22;
      draw(one(`Signed for ${p.name} (${p.role})`), bold, BODY);
      y -= 18;
      ensure(40);
      if (!dry) page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.75 });
      y -= 12;
      draw("Signature", font, 9, 11);
      y -= 14;
      draw(one(`Name: ${p.name}`), font, BODY);
      draw("Date: ____________________", font, BODY);
    }
  };
  if (!doc.parties.length) return pdf.save({ useObjectStreams: false });
  const y0 = y;
  dry = true;
  sigBlock();
  const used = y0 - y;
  dry = false;
  y = y0;
  if (y - used < M && used <= H - 2 * M) newPage(); // a block taller than a page must split (very many parties)
  sigBlock();
  return pdf.save({ useObjectStreams: false });
}
