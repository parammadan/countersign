// Deterministic field detector. Input: text items with coordinates. Output: proposed fields.
// No LLM. Every proposal carries a confidence and a human-readable reason.

import { charWeight, type Extracted, type PageText, type TextItem, type HLine } from "./pdf/extract";
import type { Field, FieldType, Role } from "./fields";
import { slugKey } from "./util";

type Ch = { c: string; x0: number; x1: number };
type Line = { page: number; y: number; bottom: number; size: number; chars: Ch[]; text: string; x0: number; x1: number };
type Seg = { line: Line; text: string; x0: number; x1: number; i0: number; i1: number };

export type DetectOptions = { firmName?: string };
export type Detection = {
  fields: Field[];
  warnings: string[];
  textLayer: boolean;
  defined: { firm: string[]; client: string[] };
};

const SIG_RE = /\b(signature|signed|sign here|signatory|by)\b/i;

function classify(label: string): FieldType {
  const l = label.toLowerCase().replace(/[:.\s]+$/, "");
  if (/\binitials?\b/.test(l)) return "initials";
  if (/\b(signature|signed|sign here|signatory)\b/.test(l) || /^(\w+\s+)?by$/.test(l) || /\bby\s*$/.test(l)) return "signature";
  if (/\be-?mail\b/.test(l)) return "email";
  if (/\bdate\b|\bdated\b|\bday of\b|\bmade on\b|\bentered into on\b|\bas of\b|\bon this\b|\beffective\b/.test(l)) return "date";
  if (/\btitle\b|\bposition\b|\bcapacity\b|\bits\s*$/.test(l)) return "title";
  if (/\b(printed|print|full|legal)?\s*name\b/.test(l)) return "name";
  if (/\b(company|organization|organisation|entity|business)\b/.test(l)) return "company";
  return "text";
}

const FIRM_WORDS = ["provider", "service provider", "consultant", "contractor", "agency", "firm", "vendor", "supplier", "licensor", "developer", "studio"];
const CLIENT_WORDS = ["client", "customer", "buyer", "purchaser", "licensee", "subscriber", "recipient", "member", "patient", "owner", "you"];

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
  const w = cleanLabel(s).split(" ").filter(Boolean);
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
        if (!label) {
          // label written under the line ("_____ \n Signature")
          const under = below.find((b) => b.y - line.bottom < line.size * 1.8 && overlap(b, x0, x1));
          const seg = under && segments(under).find((s) => s.x1 > x0 - 10 && s.x0 < x1 + 10);
          if (seg && cleanLabel(seg.text).split(" ").length <= 7) {
            label = cleanLabel(seg.text);
            reason = `blank above "${label}"`;
            conf = 0.8;
            lineY = under!.y;
          } else {
            label = "";
            reason = "unlabelled blank";
            conf = 0.4;
          }
        }
        let type = label ? classify(label) : "text";
        let labelParty = partyOf(label, defined);
        // `and ________ ("Client")`: the defined term after the blank names whose name goes there
        const after = /^\s*,?\s*\(?\s*(?:the\s+|each\s+)?["“]([^"”]{2,40})["”]/.exec(line.text.slice(i1, i1 + 50));
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
      // 2) bare labels with empty space after them ("Signature:", "By:", "Name:")
      if (consumedTo === 0) {
        const segs = segments(line);
        segs.forEach((seg, si) => {
          const t = cleanLabel(seg.text);
          if (!t || t.length > 48) return;
          const endsColon = /:\s*$/.test(seg.text.trim());
          const words = t.split(" ").length;
          const type = classify(t);
          const signerish = type !== "text" && type !== "company";
          if (!(endsColon && words <= 6 && (signerish || SIG_RE.test(t))) && !(/^(signature|by)$/i.test(t) && words === 1)) return;
          // caption printed under a drawn line ("____\nSignature"): handled by the drawn-line rule
          if (page.hlines.some((h) => h.y <= line.y + 2 && line.y - h.y < line.size * 1.6 && h.x1 > seg.x0 - 5 && h.x0 < seg.x1 + 5)) return;
          const next = segs[si + 1];
          const right = next ? next.x0 - 6 : Math.min(page.width - 50, seg.x1 + 220);
          const x0 = seg.x1 + 4;
          if (right - x0 < 50) return;
          // a drawn line right of/under the label strengthens it
          const hl = page.hlines.find((h) => !usedHLines.has(h) && h.y > line.y - 2 && h.y < line.bottom + line.size && h.x1 > x0 && h.x0 < right);
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
        const after = cleanLabel(line.text.slice(m.index + m[0].length, m.index + m[0].length + 60));
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
      const t = cleanLabel(seg.text);
      if (!t || t.split(" ").length > 6) continue;
      const type = classify(t);
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
      if (b.anchor.page !== r.page) continue;
      const a = b.anchor;
      const sameLine = Math.abs(r.y + r.h - (a.y + a.h)) < 6;
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
        if (dy <= 130 || (r.y - lastY > -5 && r.y - lastY <= 50)) dist = Math.abs(dy) * 0.6 + dx * 0.8;
      }
      if (dist < bestD) {
        bestD = dist;
        best = b;
      }
    }
    if (best) best.members.push(r);
  }
  // party for each block: label party, else heading above in same column
  for (const b of blocks) {
    const lp = b.members.map((m) => m.labelParty).find(Boolean);
    if (lp) {
      b.party = lp;
      b.why = "label names the party";
      b.conf = 0.9;
      continue;
    }
    const h = headingParty(b.anchor, allLines[b.anchor.page], d);
    if (h) {
      b.party = h.party;
      b.why = `under "${h.text}"`;
      b.conf = 0.85;
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
      if (lp === "client" && type === "name") {
        role = "prefill";
        prefillKey = "client.name";
      } else if (lp === "client" && type === "email") {
        role = "prefill";
        prefillKey = "client.email";
      } else if (lp === "client" && type === "company") {
        role = "prefill";
        prefillKey = "client.company";
      } else if (type === "date" && /effective|dated|day of|as of|date of/i.test(r.label + " " + r.reason)) {
        role = "prefill";
        prefillKey = "file.date";
      } else if (type === "date") {
        role = "prefill";
        prefillKey = "file.date";
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
      label: r.label,
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
  void opts;
  return out;
}

function headingParty(anchor: Raw, lines: Line[], d: { firm: string[]; client: string[] }) {
  // Walk up from the block, in its column, to the nearest line naming a party. Stop at body text.
  const above = lines.filter((l) => l.y < anchor.lineY - 1 && anchor.lineY - l.y <= 220).sort((a, b) => b.y - a.y);
  for (const l of above) {
    const segs = segments(l)
      .filter((s) => !(s.x1 < anchor.x - 120 || s.x0 > anchor.x + anchor.w + 40))
      .sort((a, b) => colDist(a, anchor) - colDist(b, anchor));
    for (const s of segs) {
      const t = cleanLabel(s.text);
      if (!t || t.length > 90) continue;
      const p = partyOf(t, d);
      if (p) return { party: p, text: t };
    }
    const body = segs.some((s) => s.text.length > 70 && /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(s.text));
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
