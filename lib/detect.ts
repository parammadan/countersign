// Deterministic field detector. Input: text items with coordinates. Output: proposed fields.
// No LLM. Every proposal carries a confidence and a human-readable reason.

import { charWeight, type Extracted, type PageText, type TextItem, type HLine } from "./pdf/extract";
import type { Field, FieldType, Role } from "./fields";
import { slugKey } from "./util";

type Ch = { c: string; x0: number; x1: number };
type Line = { page: number; y: number; bottom: number; size: number; chars: Ch[]; text: string; x0: number; x1: number };
type Seg = { line: Line; text: string; x0: number; x1: number; i0: number; i1: number };

export type Party = { role: string; name: string };
export type DetectOptions = {
  firmName?: string;
  /**
   * The agreement's own parties, when the caller knows them (Agreement Studio). With `workspaceNames`, the party whose
   * name is the workspace's is the firm and the other the client. Ignored unless exactly one of two parties matches.
   */
  parties?: Party[];
  /** The workspace's names (legal name, display name) to find its party among `parties`. */
  workspaceNames?: string[];
};
export type Detection = {
  fields: Field[];
  warnings: string[];
  textLayer: boolean;
  defined: { firm: string[]; client: string[] };
};

const SIG_RE = /\b(signature|signed|sign here|signatory|by)\b/i;

function classify(label: string): FieldType {
  const l = label.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").replace(/[:.\s]+$/, "").trim();
  if (/\b(approved|accepted|agreed|acknowledged|executed|witnessed)\s+by$/.test(l)) return "signature";
  // "signatory email", "name of signatory", "signature date": the other word says what goes in the blank
  if (/\b(signature|signed|signatory|signer)\b/.test(l)) {
    if (/\be-?mail\b/.test(l)) return "email";
    if (/\bname\b/.test(l)) return "name";
    if (/\btitle\b|\bposition\b/.test(l)) return "title";
    if (/\bdate\b/.test(l)) return "date";
  }
  if (l === "x") return "signature";
  if (/^on$|^on date$/.test(l)) return "date";
  if (/^dear$/.test(l)) return "name";
  if (/^(to|attn|attention)$/.test(l)) return "company";
  if (/\bprint(ed)?\s+name\b/.test(l)) return "name";
  if (/\binitials\b|^initial$|\binitial here\b|\b(client|owner|customer)'?s? initial\b/.test(l)) return "initials";
  if (/\b(signature|signed|sign here|signatory)\b/.test(l) || /^(\w+\s+)?by$/.test(l) || /\bby\s*$/.test(l)) return "signature";
  if (/\be-?mail\b/.test(l)) return "email";
  if (/\bdate\b|\bdated\b|\bday of\b|\bmade on\b|\bentered into on\b|\bas of\b|\bon this\b|\beffective\b|\bbegins? on\b|\bcommenc\w* on\b|\bstart\w* on\b|\bends? on\b|\bexpires? on\b|\bdue$|\bdue on\b|\bdeadline\b/.test(l)) return "date";
  if (/\btitle\b|\bposition\b|\bcapacity\b|\bits\s*$|\boffice held\b|\bdesignation\b/.test(l)) return "title";
  if (/\b(project|matter|business|trade|file|case|account|product|event|venue|program|campaign|job|property)\s+name\b/.test(l)) return /business|trade/.test(l) ? "company" : "text";
  if (/\blegal name\b|\bentity name\b|\bcompany name\b|\borganization name\b/.test(l)) return "company";
  if (/\b(printed|print|full)?\s*name\b/.test(l)) return "name";
  if (/\b(company|organization|organisation|entity|business)\b/.test(l)) return "company";
  return "text";
}

const FIRM_WORDS = ["provider", "service provider", "consultant", "contractor", "agency", "firm", "vendor", "supplier", "licensor", "developer", "studio", "coach", "photographer", "designer", "accountant", "accountants", "attorney", "attorneys", "counsel", "law firm", "advisor", "adviser", "planner", "trainer", "practitioner", "agent", "broker", "we", "us"];
const CLIENT_WORDS = ["client", "customer", "buyer", "purchaser", "licensee", "subscriber", "recipient", "member", "patient", "owner", "homeowner", "policyholder", "you", "the client", "undersigned"];

// caption under a line that means "sign here" even without the word signature
const SIGN_CAPTION = /\b(authori[sz]ed|representative|signatory|signature|partner|director|officer|president|principal|managing|manager|member|owner|proprietor|founder|ceo)\b/i;
function looksLikePersonLine(t: string) {
  // "Priya Fakehart, CPA, Engagement Partner" / "Dana Lee"
  const x = t.trim();
  return /^[A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3}\s*,\s*[A-Za-z .&–-]+/.test(x) || /\b(CPA|Esq|PCC|MBA|PhD|JD|CFA|CFP|PE|RA)\b/.test(x);
}

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[“”"'’(),.]/g, " ")
    .replace(/\b(llc|inc|ltd|corp|co|corporation|incorporated|limited|plc|lp|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLines(page: PageText): Line[] {
  const items = page.items.filter((i) => i.str.length > 0).slice();
  items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x);
  const lines: { base: number; items: TextItem[] }[] = [];
  for (const it of items) {
    const base = it.y + it.h * 0.8;
    const tol = Math.max(2, it.h * 0.35);
    const ln = lines.find((l) => Math.abs(l.base - base) <= tol);
    if (ln) ln.items.push(it);
    else lines.push({ base, items: [it] });
  }
  const out: Line[] = [];
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    const chars: Ch[] = [];
    let lastX1 = -Infinity;
    let size = 0;
    for (const it of l.items) {
      size = Math.max(size, it.size);
      if (chars.length && it.x - lastX1 > Math.max(1.2, it.size * 0.15)) {
        chars.push({ c: " ", x0: lastX1, x1: it.x });
      }
      const n = it.str.length;
      const total = [...it.str].reduce((a, c) => a + charWeight(c), 0) || 1;
      let cx = it.x;
      for (let k = 0; k < n; k++) {
        const cw = (charWeight(it.str[k]) / total) * it.w;
        chars.push({ c: it.str[k], x0: cx, x1: cx + cw });
        cx += cw;
      }
      lastX1 = Math.max(lastX1, it.x + it.w);
    }
    const text = chars.map((c) => c.c).join("");
    if (!text.trim()) continue;
    out.push({
      page: page.index,
      y: Math.min(...l.items.map((i) => i.y)),
      bottom: Math.max(...l.items.map((i) => i.y + i.h)),
      size: size || 10,
      chars,
      text,
      x0: chars[0].x0,
      x1: chars[chars.length - 1].x1,
    });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}

// Split a line into segments separated by wide gaps (multi-column signature tables).
function segments(line: Line): Seg[] {
  const segs: Seg[] = [];
  let start = 0;
  const gapMin = Math.max(18, line.size * 2.2);
  for (let i = 0; i < line.chars.length; i++) {
    const ch = line.chars[i];
    if (ch.c === " " && ch.x1 - ch.x0 >= gapMin) {
      if (i > start) segs.push(mkSeg(line, start, i));
      start = i + 1;
    }
  }
  if (start < line.chars.length) segs.push(mkSeg(line, start, line.chars.length));
  return segs.filter((s) => s.text.trim().length > 0);
}

function mkSeg(line: Line, i0: number, i1: number): Seg {
  const cs = line.chars.slice(i0, i1);
  return { line, text: cs.map((c) => c.c).join(""), x0: cs[0].x0, x1: cs[cs.length - 1].x1, i0, i1 };
}

type Raw = {
  page: number;
  type: FieldType;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lineY: number;
  confidence: number;
  reason: string;
  labelParty?: Role;
};

function cleanLabel(s: string): string {
  return s
    .replace(/[_.…]{2,}/g, " ")
    .replace(/[\[\]☐□]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,;-]+|[\s:,;-]+$/g, "")
    .trim();
}

function lastWords(s: string, n: number) {
  const tail = s.split(/[)”"]\s*[,.;]?\s+/).pop() ?? s; // text after the last closing paren/quote
  const w = cleanLabel(tail).split(" ").filter(Boolean);
  return w.slice(-n).join(" ");
}

export function detectFields(ex: Extracted, opts: DetectOptions = {}): Detection {
  const warnings: string[] = [];
  const textLayer = ex.textChars > 40;
  if (!textLayer) {
    warnings.push("This PDF has little or no selectable text (it may be a scan). Place the fields by hand, or a signature page will be added.");
  }
  if (textLayer) {
    const scanned = ex.pages.filter((p) => p.items.reduce((a, i) => a + i.str.trim().length, 0) < 5).map((p) => p.index + 1);
    if (scanned.length) warnings.push(`Page${scanned.length > 1 ? "s" : ""} ${scanned.join(", ")} ${scanned.length > 1 ? "have" : "has"} no selectable text (scanned?). Place any fields there by hand.`);
  }
  const allLines = ex.pages.map(buildLines);
  const fullText = allLines.flat().map((l) => l.text).join("\n");
  const defined = definedTerms(fullText, opts.firmName);
  const raws: Raw[] = [];

  for (const page of ex.pages) {
    const lines = allLines[page.index];
    const usedHLines = new Set<HLine>();
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const below = lines.slice(li + 1, li + 4);
      // 1) explicit blanks: ____ or ...... runs
      const re = /_{3,}|\.{8,}|…{3,}/g;
      let m: RegExpExecArray | null;
      let consumedTo = 0;
      while ((m = re.exec(line.text))) {
        const i0 = m.index;
        const i1 = m.index + m[0].length;
        const x0 = line.chars[i0].x0;
        const x1 = line.chars[i1 - 1].x1;
        const before = line.text.slice(consumedTo, i0);
        consumedTo = i1;
        let label = lastWords(before.split(/\s{3,}/).pop() ?? "", 6);
        let reason = `blank after "${label}"`;
        let conf = 0.85;
        let lineY = line.y;
        if (!label && li > 0) {
          // sentence wrapped onto this line: "... MSA dated\n________"
          const prev = lines[li - 1];
          if (i0 < 3 && line.y - prev.bottom < line.size * 0.8 && !/[.:;]\s*$/.test(prev.text) && overlap(prev, x0, x1)) {
            const w = lastWords(prev.text, 4);
            if (w && classify(w) !== "text") {
              label = w;
              reason = `blank continuing "${w}"`;
            }
          }
        }
        if (!label) {
          // label written under the line ("_____ \n Signature")
          const under = below.find((b) => b.y - line.bottom < line.size * 1.8 && overlap(b, x0, x1));
          const seg = under && segments(under).find((s) => s.x1 > x0 - 10 && s.x0 < x1 + 10);
          if (seg && cleanLabel(seg.text).split(" ").length <= 7 && !/^(to|re|dear|attn|from|subject|cc)\b/i.test(cleanLabel(seg.text))) {
            label = cleanLabel(seg.text);
            reason = `blank above "${label}"`;
            conf = 0.8;
            lineY = under!.y;
            if (classify(label) === "text" && (SIGN_CAPTION.test(label) || looksLikePersonLine(label))) {
              reason = `blank above "${label}" (a signer's caption)`;
              label = `Signature (${label})`;
            }
          } else if (page.index === 0 && line.y < page.height * 0.3 && x0 < page.width * 0.45 && line.text.replace(/[_\s]/g, "").length === 0) {
            label = "Date";
            reason = "unlabelled blank at the top of a letter (its date)";
            conf = 0.5;
          } else {
            label = "";
            reason = "unlabelled blank";
            conf = 0.4;
          }
        }
        const afterText = line.text.slice(i1, i1 + 70);
        if (!label) {
          // "______ Initials" / "______ (Client signature)": label written after the blank
          const w = cleanLabel(afterText.replace(/[()]/g, " ")).split(" ").slice(0, 4).join(" ");
          if (w && classify(w) !== "text") {
            label = w;
            reason = `blank before "${w}"`;
            conf = 0.7;
          }
        }
        let type = label ? classify(label) : "text";
        let labelParty = partyOf(label, defined);
        const paren = /^\s*\(([^)]{2,70})\)/.exec(afterText);
        if (paren && !labelParty) labelParty = partyOf(paren[1], defined);
        // `and ________ ("Client")`: the defined term after the blank names whose name goes there
        const nextStart = afterText.trim() ? afterText : (lines[li + 1]?.text ?? "").slice(0, 60);
        const after = /^\s*,?\s*\(?\s*(?:the\s+|each\s+|hereinafter\s+)?["“]([^"”]{2,40})["”]/.exec(nextStart);
        if (after && (type === "text" || type === "company")) {
          const p = partyOf(after[1], defined);
          if (p) {
            labelParty = p;
            type = "name";
            label = `${after[1]} name`;
            reason = `blank before ("${after[1]}")`;
          }
        }
        const h = fieldHeight(type, line.size);
        raws.push({
          page: page.index,
          type,
          label: label || "Blank",
          x: x0,
          y: line.y + line.size - h + 1,
          w: Math.max(40, x1 - x0),
          h,
          lineY,
          confidence: conf,
          reason,
          labelParty,
        });
      }
      // 2a) form rows: "Client legal name ______" where the line is drawn, not typed
      const rowSegs = new Set<number>();
      if (consumedTo === 0) {
        const segs = segments(line);
        segs.forEach((seg, si) => {
          const t = cleanLabel(seg.text);
          if (!t || t.length > 60 || t.split(" ").length > 8) return;
          const next = segs[si + 1];
          // labels reach across to their line, unless the "label" is really a caption or a printed name
          const isCaption = page.hlines.some((h) => h.y <= line.y + 2 && line.y - h.y < line.size * 1.6 && h.x1 > seg.x0 && h.x0 < seg.x1);
          const reach = /:\s*$/.test(seg.text.trim()) ? 230 : isCaption || looksLikePersonLine(t) ? 0 : 200;
          const hl = page.hlines.find(
            (h) =>
              !usedHLines.has(h) &&
              h.y >= line.y + line.size * 0.4 &&
              h.y <= line.bottom + 5 &&
              h.x0 >= seg.x1 - 4 &&
              h.x0 - seg.x1 < reach &&
              h.x1 - h.x0 >= 50 &&
              (!next || next.x0 >= h.x1 - 4),
          );
          if (!hl) return;
          usedHLines.add(hl);
          rowSegs.add(si);
          const type = classify(t);
          const h = fieldHeight(type, line.size);
          raws.push({
            page: page.index,
            type,
            label: t,
            x: hl.x0,
            y: hl.y - h + 1,
            w: hl.x1 - hl.x0,
            h,
            lineY: line.y,
            confidence: type === "text" ? 0.6 : 0.8,
            reason: `form row "${t}" with a drawn line`,
            labelParty: partyOf(t, defined),
          });
        });
      }
      // 2b) bare labels with empty space after them ("Signature:", "By:", "Name:")
      if (consumedTo === 0) {
        const segs = segments(line);
        segs.forEach((seg, si) => {
          if (rowSegs.has(si)) return;
          const t = cleanLabel(seg.text);
          if (!t || t.length > 48) return;
          const endsColon = /:\s*$/.test(seg.text.trim());
          const words = t.split(" ").length;
          const type = classify(t);
          const signerish = type !== "text" && type !== "company";
          if (!(endsColon && words <= 6 && (signerish || SIG_RE.test(t))) && !(/^(signature|by)$/i.test(t) && words === 1)) return;
          // caption printed under a drawn line ("____\nSignature"): handled by the drawn-line rule
          const cellBelow = endsColon && page.hlines.some((h) => h.y >= line.bottom - 3 && h.y - line.bottom < line.size * 1.2 && h.x0 <= seg.x0 + 5 && h.x1 > seg.x1 + 50);
          if (!cellBelow && page.hlines.some((h) => h.y <= line.y + 2 && line.y - h.y < line.size * 1.6 && h.x1 > seg.x0 - 5 && h.x0 < seg.x1 + 5)) return;
          if (raws.some((r) => r.page === page.index && r.y + r.h <= line.y + 3 && line.y - (r.y + r.h) < line.size * 1.2 && r.x < seg.x1 + 5 && r.x + r.w > seg.x0 - 5)) return;
          const next = segs[si + 1];
          const right = next ? next.x0 - 6 : Math.min(page.width - 50, seg.x1 + 220);
          const x0 = seg.x1 + 4;
          if (right - x0 < 50) return;
          // a drawn line right of/under the label strengthens it
          const hl = page.hlines.find((h) => !usedHLines.has(h) && h.y > line.y - 2 && h.y < line.bottom + line.size && h.x1 > x0 && h.x0 < right && h.x0 < x0 + 40);
          if (hl) usedHLines.add(hl);
          const fx0 = hl ? Math.max(x0, hl.x0) : x0;
          const fx1 = hl ? Math.min(right, hl.x1) : right;
          const h = fieldHeight(type, line.size);
          raws.push({
            page: page.index,
            type,
            label: t,
            x: fx0,
            y: line.y + line.size - h + 1,
            w: Math.max(50, fx1 - fx0),
            h,
            lineY: line.y,
            confidence: hl ? 0.8 : 0.65,
            reason: hl ? `label "${t}" with a drawn line` : `label "${t}" followed by empty space`,
            labelParty: partyOf(t, defined),
          });
        });
      }
      // 3) checkboxes ☐ / [ ]
      const cb = /☐|□|\[\s\]/g;
      while ((m = cb.exec(line.text))) {
        const c = line.chars[m.index];
        const after = cleanLabel(line.text.slice(m.index + m[0].length, m.index + m[0].length + 60).split(/☐|□|\[\s\]/)[0]);
        raws.push({
          page: page.index,
          type: "checkbox",
          label: after.split(" ").slice(0, 6).join(" ") || "Checkbox",
          x: c.x0 - 1,
          y: line.y - 1,
          w: line.size + 2,
          h: line.size + 2,
          lineY: line.y,
          confidence: 0.7,
          reason: "checkbox mark",
          labelParty: partyOf(after, defined),
        });
      }
    }
    // 4) drawn lines with a label directly underneath and no text on them
    for (const hl of page.hlines) {
      if (usedHLines.has(hl)) continue;
      if (raws.some((r) => r.page === page.index && Math.abs(r.y + r.h - hl.y) < 6 && r.x < hl.x1 && r.x + r.w > hl.x0)) continue;
      const under = lines.find((l) => l.y > hl.y - 1 && l.y - hl.y < 16 && overlap(l, hl.x0, hl.x1));
      if (!under) continue;
      const seg = segments(under).find((s) => s.x1 > hl.x0 - 5 && s.x0 < hl.x1 + 5);
      if (!seg) continue;
      let t = cleanLabel(seg.text);
      if (!t || t.split(" ").length > 7) continue;
      // a form row ("Label ____" or "Label:" in a cell) under this line, or text sitting just above it,
      // means it's a box or table edge, not a signature rule. (Text above that is itself the caption of
      // the previous rule, as in stacked "____ / Printed name / ____ / Title" blocks, doesn't count.)
      if (/_{3,}/.test(under.text)) continue;
      if (/:\s*$/.test(seg.text.trim())) continue;
      const isCaptionOfAnotherRule = (l: Line) => page.hlines.some((h2) => h2 !== hl && h2.y <= l.y + 2 && l.y - h2.y < l.size * 1.8 && h2.x1 > l.x0 && h2.x0 < l.x1);
      if (lines.some((l) => l.bottom > hl.y - 18 && l.bottom <= hl.y + 1 && overlap(l, hl.x0 + 10, hl.x1 - 10) && l.text.trim().length > 1 && !isCaptionOfAnotherRule(l))) continue;
      let type = classify(t);
      if (type === "text" && (SIGN_CAPTION.test(t) || looksLikePersonLine(t))) {
        type = "signature";
        t = `Signature (${t})`;
      }
      if (type === "text" && !SIG_RE.test(t)) continue;
      const h = fieldHeight(type, under.size);
      raws.push({
        page: page.index,
        type,
        label: t,
        x: hl.x0,
        y: hl.y - h,
        w: hl.x1 - hl.x0,
        h,
        lineY: under.y,
        confidence: 0.7,
        reason: `drawn line above "${t}"`,
        labelParty: partyOf(t, defined),
      });
      usedHLines.add(hl);
    }
    // Captions-under rules other than signatures only count inside a signature stack: a signature
    // rule directly above in the same column. Otherwise they're table/grid rows ("Contact email").
    for (let i = raws.length - 1; i >= 0; i--) {
      const r = raws[i];
      if (r.page !== page.index || !r.reason.startsWith("drawn line above") || r.type === "signature" || r.type === "initials") continue;
      const sigAbove = raws.some(
        (o) =>
          o.page === r.page &&
          o.type === "signature" &&
          ((o.y < r.y && r.y - o.y < 170 && Math.abs(o.x - r.x) < 40) || // stacked under the signature
            (Math.abs(o.y + o.h - (r.y + r.h)) < 6 && r.x > o.x && r.x - (o.x + o.w) < 120)), // beside it on the same rule row
      );
      if (!sigAbove) raws.splice(i, 1);
    }
    // 5) signature tables: header row "Party | Signature | Date", one row per party, empty cells
    for (let li = 0; li < lines.length; li++) {
      const hdr = segments(lines[li]);
      if (hdr.length < 2 || hdr.length > 5) continue;
      const cols = hdr.map((sg) => ({ sg, t: cleanLabel(sg.text) })).filter((c) => c.t.split(" ").length <= 3);
      const sigCol = cols.findIndex((c) => /^(signature|sign|signed|signature of party)$/i.test(c.t));
      if (sigCol < 0 || cols.length !== hdr.length) continue;
      const fieldCols = cols
        .map((c, i) => ({ ...c, i, type: i === sigCol ? ("signature" as FieldType) : classify(c.t) }))
        .filter((c) => c.i === sigCol || ["date", "name", "title"].includes(c.type));
      if (!fieldCols.length) continue;
      // rows: lines below whose leftmost text names a party
      const rowLines = lines.filter((l) => l.y > lines[li].bottom && l.y - lines[li].bottom < 170);
      const leftText = (l: Line) => segments(l).filter((sg) => sg.x1 < fieldCols[0].sg.x0).map((sg) => sg.text).join(" ").trim();
      const groups: Line[][] = [];
      for (const l of rowLines) {
        if (!leftText(l)) continue;
        const g = groups[groups.length - 1];
        const last = g?.[g.length - 1];
        if (last && l.y - last.bottom < l.size * 0.9) g.push(l);
        else groups.push([l]);
      }
      const starts = groups.filter((g) => partyOf(g.map(leftText).join(" "), defined)).map((g) => g[0]);
      if (!starts.length) continue;
      starts.forEach((st, ri) => {
        const end = ri + 1 < starts.length ? starts[ri + 1].y : st.y + 50;
        const rowText = rowLines.filter((l) => l.y >= st.y - 1 && l.y < end).map((l) => segments(l).filter((sg) => sg.x1 < fieldCols[0].sg.x0).map((sg) => sg.text).join(" ")).join(" ");
        const party = partyOf(rowText, defined);
        fieldCols.forEach((c, k) => {
          const nextCol = cols[c.i + 1];
          const x0 = c.sg.x0 - 3;
          const x1 = nextCol ? nextCol.sg.x0 - 8 : Math.min(page.width - 40, c.sg.x0 + 150);
          const occupied = rowLines.some((l) => l.y >= st.y - 1 && l.y < end && segments(l).some((sg) => sg.x0 < x1 && sg.x1 > x0));
          if (occupied) return;
          const h = c.type === "signature" ? Math.min(30, Math.max(20, end - st.y - 6)) : fieldHeight(c.type, st.size);
          raws.push({
            page: page.index,
            type: c.type,
            label: `${c.t} (${cleanLabel(rowText).slice(0, 40)})`,
            x: x0,
            y: st.y - 2,
            w: Math.max(40, x1 - x0),
            h,
            lineY: st.y,
            confidence: party ? 0.75 : 0.5,
            reason: `signature table column "${c.t}", row "${cleanLabel(rowText).slice(0, 40)}"`,
            labelParty: party,
          });
          void k;
        });
      });
    }
    // 6) checkbox squares drawn as vectors
    for (const b of page.boxes) {
      if (raws.some((r) => r.page === page.index && r.type === "checkbox" && Math.abs(r.x - b.x) < 6 && Math.abs(r.y - b.y) < 6)) continue;
      const ln = lines.find((l) => l.y - 3 < b.y + b.h && l.bottom + 3 > b.y && l.x0 > b.x + b.w - 2 && l.x0 - (b.x + b.w) < 30);
      const right = ln ? cleanLabel(ln.text).split(" ").slice(0, 8).join(" ") : "";
      raws.push({
        page: page.index,
        type: "checkbox",
        label: right || "Checkbox",
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        lineY: b.y,
        confidence: right ? 0.7 : 0.45,
        reason: "drawn checkbox square",
        labelParty: undefined,
      });
    }
  }

  const fields = assignRoles(raws, allLines, defined, opts, warnings);
  return { fields, warnings, textLayer, defined };
}

function overlap(l: { x0: number; x1: number }, x0: number, x1: number) {
  return l.x1 > x0 - 10 && l.x0 < x1 + 10;
}

function fieldHeight(type: FieldType, size: number) {
  if (type === "signature") return Math.max(24, size * 2.4);
  if (type === "initials") return Math.max(18, size * 1.8);
  return Math.max(13, size * 1.35);
}

// Defined terms from the preamble: `Astra AI, LLC ("Astra" or the "Company")` and `("Client")`.
export function definedTerms(text: string, firmName?: string): { firm: string[]; client: string[] } {
  const firm = new Set<string>();
  const client = new Set<string>();
  const firmN = firmName ? norm(firmName) : "";
  const firmTok = firmN.split(" ").filter((w) => w.length > 2);
  if (firmN) {
    firm.add(firmN);
    if (firmTok[0]) firm.add(firmTok[0]);
  }
  const re = /\(\s*(?:each\s+)?(?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?(?:the\s+)?["“]([^"”]{2,40})["”](?:\s*(?:,|or|and)\s*(?:the\s+)?["“]([^"”]{2,40})["”])?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const terms = [m[1], m[2]].filter(Boolean).map((t) => norm(t!));
    const before = norm(text.slice(Math.max(0, m.index - 140), m.index));
    const tail = before.split(/\band\b|\bbetween\b|;/).pop() ?? before;
    const isFirm =
      (firmN && (tail.includes(firmN) || (firmTok[0] && tail.includes(firmTok[0])))) ||
      terms.some((t) => FIRM_WORDS.includes(t));
    const isClient = terms.some((t) => CLIENT_WORDS.includes(t)) || /\bclient\b|\bcustomer\b|undersigned/.test(tail);
    for (const t of terms) {
      if (["agreement", "effective date", "services", "parties", "party", "term", "fees", "sow", "statement of work"].includes(t)) continue;
      if (isFirm && !isClient) firm.add(t);
      else if (isClient && !isFirm) client.add(t);
    }
  }
  return { firm: [...firm], client: [...client] };
}

/** Name key for comparing a party with the workspace: case, punctuation and spacing ignored, nothing else. */
const nameKey = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The firm's and the client's party among exactly two known parties: the one whose name is one of the workspace's
 * names is the firm. null when neither or both match (or the names don't tell them apart): the caller then detects
 * as for any upload, without guessing.
 */
export function knownSigners(parties: Party[] | undefined, workspaceNames: (string | undefined | null)[]): { firm: Party; client: Party } | null {
  if (!parties || parties.length !== 2) return null;
  const ws = new Set(workspaceNames.map((n) => nameKey(n ?? "")).filter(Boolean));
  const keys = parties.map((p) => nameKey(p.name));
  if (!keys[0] || !keys[1] || keys[0] === keys[1] || nameKey(parties[0].role) === nameKey(parties[1].role)) return null;
  const hits = keys.map((k) => ws.has(k));
  if (hits[0] === hits[1]) return null;
  const f = hits[0] ? 0 : 1;
  return { firm: parties[f], client: parties[1 - f] };
}

/** partyOf for known parties: only their names and roles count, not the generic firm/client words. */
function knownPartyOf(s: { firm: Party; client: Party }) {
  // a name that is only a form word once LLC/Inc are dropped ("Signature LLC" -> "signature") would match the field
  // labels of every block, so it never counts
  const FIELD = new Set(["signature", "sign", "signed", "date", "dated", "name", "print", "printed", "title", "by", "email", "initials", "witness"]);
  const words = (p: Party) => [norm(p.name), norm(p.role)].filter((w) => w.length >= 2 && !FIELD.has(w));
  const d = { firm: words(s.firm), client: words(s.client) };
  return (text: string): Role | undefined => {
    const t = " " + norm(text) + " ";
    if (!t.trim()) return undefined;
    const has = (w: string) => t.includes(" " + w + " ");
    const firmHit = d.firm.some(has);
    const clientHit = d.client.some(has);
    if (firmHit && !clientHit) return "firm";
    if (clientHit && !firmHit) return "client";
    return undefined;
  };
}

function partyOf(text: string, d: { firm: string[]; client: string[] }): Role | undefined {
  const t = " " + norm(text) + " ";
  if (!t.trim()) return undefined;
  const has = (w: string) => t.includes(" " + w + " ");
  const firmHit = d.firm.some(has) || FIRM_WORDS.some(has);
  const clientHit = d.client.some(has) || CLIENT_WORDS.some(has);
  if (firmHit && !clientHit) return "firm";
  if (clientHit && !firmHit) return "client";
  return undefined;
}

function assignRoles(raws: Raw[], allLines: Line[][], d: { firm: string[]; client: string[] }, opts: DetectOptions, warnings: string[]): Field[] {
  // de-duplicate overlapping proposals (keep higher confidence)
  raws.sort((a, b) => b.confidence - a.confidence);
  const kept: Raw[] = [];
  for (const r of raws) {
    if (kept.some((k) => k.page === r.page && iou(k, r) > 0.3)) continue;
    kept.push(r);
  }
  kept.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  for (let i = kept.length - 1; i >= 0; i--) {
    const r = kept[i];
    if (r.type !== "signature" || !/followed by empty space/.test(r.reason)) continue;
    const below = kept.some((o) => o !== r && o.page === r.page && o.type === "signature" && o.y > r.y + 4 && o.y - r.y < 80 && o.x < r.x + r.w && o.x + o.w > r.x - 150);
    if (below) kept.splice(i, 1);
  }

  // Signature blocks: each signature/initials-less signature field anchors a block.
  const sigs = kept.filter((r) => r.type === "signature");
  type Block = { anchor: Raw; members: Raw[]; party?: Role; why: string; conf: number };
  const blocks: Block[] = sigs.map((s) => ({ anchor: s, members: [s], why: "", conf: 0.5 }));
  const SIGNER_TYPES: FieldType[] = ["name", "title", "date", "email", "company"];
  const cand = kept.filter((r) => SIGNER_TYPES.includes(r.type)).sort((a, b) => a.page - b.page || a.y - b.y);
  for (const r of cand) {
    let best: Block | undefined;
    let bestD = Infinity;
    for (const b of blocks) {
      const a = b.anchor;
      if (a.page === r.page - 1 && r.y < 160) {
        // block continued at the top of the next page: same column, nothing closer
        const dx0 = Math.abs(r.x - a.x);
        if (dx0 <= 160 && !blocks.some((o) => o.anchor.page === r.page && o.anchor.y < r.y)) {
          const dist = 200 + r.y + dx0;
          if (dist < bestD) {
            bestD = dist;
            best = b;
          }
        }
        continue;
      }
      if (a.page !== r.page) continue;
      const sameLine = Math.abs(r.y + r.h - (a.y + a.h)) < 6 || (Math.abs(r.lineY - a.lineY) < 3 && /signature table/.test(a.reason));
      const dx = Math.abs(r.x - a.x);
      const dy = r.y - a.y;
      let dist = Infinity;
      if (sameLine && r.x > a.x) {
        // "Signature: ____   Date: ____": right of the anchor, unless another anchor sits between them
        const between = blocks.some((o) => o !== b && o.anchor.page === r.page && Math.abs(o.anchor.y - a.y) < 6 && o.anchor.x > a.x && o.anchor.x < r.x);
        if (!between) dist = (r.x - (a.x + a.w)) * 0.5;
      } else if (dx <= 160 && dy >= -60) {
        // stacked rows: within reach of the anchor, or directly under the block's last row
        const lastY = Math.max(...b.members.filter((m) => Math.abs(m.x - a.x) <= 160).map((m) => m.y));
        const gap = r.y - lastY;
        if (gap > -5 && gap <= 50) dist = gap * 0.6 + dx * 0.8;
        else if (dy <= 130) dist = (dy < 0 ? -dy * 3 : dy * 0.6) + dx * 0.8;
      }
      if (dist < bestD) {
        bestD = dist;
        best = b;
      }
    }
    if (best) best.members.push(r);
  }
  // Known parties (Agreement Studio): a block whose label or heading names exactly one of them belongs to it.
  // Blocks that name neither go through the rules below, as for any upload.
  const known = knownSigners(opts.parties, [opts.firmName, ...(opts.workspaceNames ?? [])]);
  if (known) {
    const who = knownPartyOf(known);
    const set: typeof blocks = [];
    for (const b of blocks) {
      const lp = b.members.map((m) => who(m.label)).find(Boolean);
      const h = lp ? undefined : headingParty(b.anchor, allLines[b.anchor.page], who, sigs.filter((k) => k !== b.anchor && k.page === b.anchor.page).map((k) => k.lineY));
      const party = lp ?? h?.party;
      if (!party) continue;
      b.party = party;
      b.why = `${lp ? "label" : `under "${h!.text}"`}: the ${party === "firm" ? "workspace's" : "other"} party (${(party === "firm" ? known.firm : known.client).role})`;
      b.conf = lp ? 0.9 : h!.conf;
      set.push(b);
    }
    // two or more blocks all given to the same party means the names didn't tell them apart: drop this pass and
    // detect as for any upload rather than have one party sign on the other's line
    if (set.length >= 2 && set.every((b) => b.party === set[0].party)) for (const b of set) { b.party = undefined; b.why = ""; b.conf = 0.5; }
  }
  // party for each block: label party, else heading above in same column
  for (const b of blocks) {
    if (b.party) continue;
    const lp = b.members.map((m) => m.labelParty).find(Boolean);
    if (lp) {
      b.party = lp;
      b.why = "label names the party";
      b.conf = 0.9;
      continue;
    }
    const h = headingParty(b.anchor, allLines[b.anchor.page], (t) => partyOf(t, d), sigs.filter((k) => k !== b.anchor && k.page === b.anchor.page).map((k) => k.lineY));
    if (h) {
      b.party = h.party;
      b.why = `under "${h.text}"`;
      b.conf = h.conf;
    }
  }
  const unresolved = blocks.filter((b) => !b.party);
  if (unresolved.length) {
    const hasClient = blocks.some((b) => b.party === "client");
    const hasFirm = blocks.some((b) => b.party === "firm");
    unresolved.forEach((b, i) => {
      if (blocks.length === 1) {
        b.party = "client";
        b.why = "only signature block, so the client";
        b.conf = 0.6;
      } else if (hasFirm && !hasClient) {
        b.party = "client";
        b.why = "the other block belongs to the firm";
        b.conf = 0.65;
      } else if (hasClient && !hasFirm) {
        b.party = "firm";
        b.why = "the other block belongs to the client";
        b.conf = 0.55;
      } else {
        b.party = i === unresolved.length - 1 && unresolved.length > 1 ? "firm" : "client";
        b.why = "party not named near this block: please check";
        b.conf = 0.35;
      }
    });
  }

  const inBlock = new Map<Raw, Block>();
  for (const b of blocks) for (const m of b.members) inBlock.set(m, b);

  const out: Field[] = [];
  let n = 0;
  const usedKeys = new Set<string>();
  for (const r of kept) {
    const b = inBlock.get(r);
    let role: Role;
    let prefillKey: string | undefined;
    let reason = r.reason;
    let conf = r.confidence;
    let type = r.type;
    if (b) {
      role = b.party!;
      reason += `; ${b.why}`;
      conf = Math.min(conf, b.conf);
    } else if (r.type === "checkbox") {
      role = "client";
    } else if (r.type === "initials") {
      role = r.labelParty === "firm" ? "firm" : "client";
    } else {
      // body blank, outside any signature block
      const lp = r.labelParty;
      if (type === "name" && /^dear\b/i.test(r.label)) {
        role = "prefill";
        prefillKey = "client.name";
      } else if (lp === "client" && type === "name") {
        role = "prefill";
        prefillKey = "client.name";
      } else if (lp === "client" && type === "email") {
        role = "prefill";
        prefillKey = "client.email";
      } else if (lp === "client" && type === "company") {
        role = "prefill";
        prefillKey = "client.company";
      } else if (type === "date" && (/^date$/i.test(r.label) || /effective|dated|day of|as of|date of (this|the) agreement|made on|entered into|letter/i.test(r.label + " " + r.reason))) {
        // the agreement's own date: the day it's sent
        role = "prefill";
        prefillKey = "file.date";
      } else if (type === "date") {
        // some other date (start date, due date): the firm fills it in per file
        role = "prefill";
        let k = "custom." + slugKey(r.label);
        while (usedKeys.has(k)) k += "_2";
        prefillKey = k;
      } else if (/\$\s*$|\b(fee|fees|price|amount|rate|deposit|retainer|cost|total|budget|sum)\b/i.test(r.label)) {
        role = "prefill";
        let k = "custom." + slugKey(r.label.replace(/\$/g, "").split(" ").slice(-3).join(" "));
        while (usedKeys.has(k)) k += "_2";
        prefillKey = k;
        type = "text";
      } else if (type === "company" && !lp && r.page === 0) {
        role = "prefill";
        prefillKey = "client.company";
      } else if (type === "email" && !lp && r.page === 0 && /contact|client|customer|your/i.test(r.label)) {
        role = "prefill";
        prefillKey = "client.email";
      } else if (type === "company" && /^(to|attn|attention)$/i.test(r.label)) {
        role = "prefill";
        prefillKey = "client.company";
      } else if (lp === "client") {
        role = "client";
        type = type === "name" ? "name" : "text";
      } else if (lp === "firm" && (type === "name" || type === "company")) {
        role = "prefill";
        prefillKey = "firm.legal_name";
      } else {
        role = "prefill";
        let k = "custom." + slugKey(r.label === "Blank" ? `blank_${n + 1}` : r.label);
        while (usedKeys.has(k)) k += "_2";
        prefillKey = k;
        if (type === "signature") type = "text";
      }
      if (prefillKey) usedKeys.add(prefillKey);
      reason += role === "prefill" ? `; filled from file data (${prefillKey})` : "; client fills it in";
    }
    out.push({
      id: `f${++n}`,
      type,
      role,
      page: r.page,
      x: round(r.x),
      y: round(r.y),
      w: round(r.w),
      h: round(r.h),
      label: r.label.replace(/[\s:$#]+$/, "") || r.label,
      required: role !== "prefill" && type !== "checkbox" ? type === "signature" || type === "initials" || type === "date" || type === "name" : false,
      prefillKey,
      confidence: Math.round(conf * 100) / 100,
      reason,
    });
  }
  // make client text inputs optional unless they're core signer fields
  if (!out.some((f) => f.role === "client" && f.type === "signature")) {
    warnings.push("No client signature line was found.");
  }
  if (!out.some((f) => f.role === "firm" && f.type === "signature")) {
    warnings.push("No signature line for your firm was found. Your acceptance will still be recorded on the certificate.");
  }
  if (out.some((f) => (f.confidence ?? 1) < 0.5)) warnings.push("Some fields are low-confidence. Check the highlighted ones.");
  return out;
}

function headingParty(anchor: Raw, lines: Line[], who: (text: string) => Role | undefined, fieldLineYs: number[]) {
  // Walk up from the block, in its column, to the nearest line naming a party. Skip the block's own
  // rows, stop at body text. If only the neighbouring column's heading names a party, this column is
  // the other party.
  const above = lines.filter((l) => l.y < anchor.lineY - 1 && anchor.lineY - l.y <= 220).sort((a, b) => b.y - a.y);
  const colX0 = anchor.x - 70;
  const colX1 = anchor.x + anchor.w + 10;
  for (const l of above) {
    // reached the rows of another signature block in this column: its heading isn't ours
    if (fieldLineYs.some((y) => Math.abs(y - l.y) < 2)) {
      const all0 = segments(l).filter((sg) => sg.x1 > colX0 && sg.x0 < colX1);
      if (all0.some((sg) => classify(cleanLabel(sg.text)) === "signature")) return undefined;
    }
    const all = segments(l);
    const mine = all.filter((sg) => sg.x1 > colX0 && sg.x0 < colX1).sort((a, b) => colDist(a, anchor) - colDist(b, anchor));
    for (const sg of mine) {
      const t = cleanLabel(sg.text);
      if (!t || t.length > 90) continue;
      const p = who(t);
      if (p) return { party: p, text: t, conf: 0.85 };
    }
    if (mine.length && all.length >= 2) {
      const others = all.filter((sg) => !mine.includes(sg)).map((sg) => who(cleanLabel(sg.text))).filter(Boolean) as Role[];
      if (others.length === 1 && others[0] !== "prefill" && cleanLabel(mine[0].text).length < 60) {
        return { party: (others[0] === "client" ? "firm" : "client") as Role, text: `${cleanLabel(mine[0].text)}, next to the ${others[0]}'s column`, conf: 0.7 };
      }
    }
    const body = mine.some((sg) => sg.text.length > 70 && /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(sg.text));
    if (body) return undefined;
  }
  return undefined;
}

function colDist(s: { x0: number; x1: number }, a: Raw) {
  const ax0 = a.x - 60;
  const ax1 = a.x + a.w;
  if (s.x1 >= ax0 && s.x0 <= ax1) return Math.abs(s.x0 - a.x) * 0.1;
  return Math.min(Math.abs(s.x1 - ax0), Math.abs(s.x0 - ax1)) + 50;
}

function iou(a: Raw, b: Raw) {
  const x0 = Math.max(a.x, b.x),
    y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w),
    y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}

function round(v: number) {
  return Math.round(v * 10) / 10;
}
