#!/usr/bin/env node
// Q10 audit: how faithful is the text that document understanding reads?
// Read-only. Runs extractPdf (lib/pdf/extract.ts) + pageLines (lib/understand/text.ts) over the fixture PDFs
// and prints one row per fixture. Also tries the DOCX path with LibreOffice on a synthetic document in a temp dir.
// Needs Node >= 22.18 (runs the .ts sources directly); older: node --experimental-strip-types scripts/audit-extraction.mjs
// Usage: node scripts/audit-extraction.mjs [--no-docx] [--json]
// Never prints document text except the first 40 chars of a repeated line (fixtures are synthetic).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const { extractPdf } = await import(path.join(root, "lib/pdf/extract.ts"));
const { pageLines } = await import(path.join(root, "lib/understand/text.ts"));

const SETS = ["agreements", "holdout", "final", "next"];
const GAP = 24; // pt: a gap this wide inside one baseline row is a column break, not a word space

// Character classes are built from code points so this file stays pure ASCII.
const cls = (ranges) => new RegExp("[" + ranges.map(([a, b]) => String.fromCodePoint(a) + (b ? "-" + String.fromCodePoint(b) : "")).join("") + "]", "g");
const LIGATURE = cls([[0xfb00, 0xfb06]]);
const ODD = cls([[0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060], [0xfeff], [0xfffd], [0xe000, 0xf8ff]]);
const CTRL = cls([[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f]]);
const NONASCII = cls([[0x80, 0x10ffff]]);
const PAGE_NO = /^(page\s+)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i;
const LEADER = /\.{4,}|(\.\s){4,}|_{6,}/;

const count = (s, re) => (s.match(re) || []).length;

// Same row grouping as pageLines, but keeps item positions so we can see column merges.
function rowGaps(page) {
  const items = page.items.filter((i) => i.str.trim()).slice();
  items.sort((a, b) => a.y + a.h * 0.8 - (b.y + b.h * 0.8) || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const base = it.y + it.h * 0.8;
    const tol = Math.max(2, it.h * 0.35);
    const row = rows.find((r) => Math.abs(r.base - base) <= tol);
    if (row) row.parts.push(it);
    else rows.push({ base, parts: [it] });
  }
  let merged = 0;
  for (const r of rows) {
    const parts = r.parts.sort((a, b) => a.x - b.x);
    let end = -Infinity;
    let wide = false;
    for (const q of parts) {
      if (end > -Infinity && q.x - end > GAP) wide = true;
      end = q.x + q.w;
    }
    if (wide) merged++;
  }
  return { rows: rows.length, merged };
}

async function audit(file) {
  const ex = await extractPdf(new Uint8Array(fs.readFileSync(file)));
  const pl = pageLines(ex);
  const all = pl.flatMap((p) => p.lines);
  const text = all.join("\n");
  let rowsN = 0;
  let merged = 0;
  for (const p of ex.pages) {
    const g = rowGaps(p);
    rowsN += g.rows;
    merged += g.merged;
  }
  // repeated lines: same text on >= 2 pages (multi-page docs only)
  const freq = new Map();
  for (const p of pl) for (const l of new Set(p.lines)) freq.set(l, (freq.get(l) || 0) + 1);
  const repeated = pl.length > 1 ? [...freq.entries()].filter(([, n]) => n >= 2) : [];
  let hyph = 0;
  for (const p of pl) for (let i = 0; i + 1 < p.lines.length; i++) if (/[A-Za-z]-$/.test(p.lines[i]) && /^[a-z]/.test(p.lines[i + 1])) hyph++;
  return {
    pages: ex.pages.length,
    chars: ex.textChars,
    lines: all.length,
    emptyPages: pl.filter((p) => p.lines.length === 0).length,
    mergedRows: merged,
    mergedPct: rowsN ? (100 * merged) / rowsN : 0,
    repeated: repeated.length,
    hyph,
    ligatures: count(text, LIGATURE),
    odd: count(text, ODD),
    ctrl: count(text, CTRL),
    nonAscii: count(text, NONASCII),
    leaders: all.filter((l) => LEADER.test(l)).length,
    pageNoPages: pl.filter((p) => p.lines.some((l) => PAGE_NO.test(l))).length,
  };
}

const rows = [];
for (const set of SETS) {
  const dir = path.join(root, "fixtures", set);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".pdf")).sort()) {
    const name = f.replace(/\.pdf$/, "");
    try {
      rows.push({ set, name, ...(await audit(path.join(dir, f))) });
    } catch (e) {
      rows.push({ set, name, error: String(e.message || e).slice(0, 80) });
    }
  }
}

if (args.has("--json")) console.log(JSON.stringify(rows, null, 1));
else {
  const cols = [
    ["set", "set", 10], ["name", "fixture", 44], ["pages", "pg", 3], ["chars", "chars", 6], ["lines", "lines", 5],
    ["emptyPages", "empty", 5], ["mergedRows", "colMrg", 6], ["mergedPct", "col%", 5], ["repeated", "rep", 3],
    ["hyph", "hyph", 4], ["ligatures", "lig", 3], ["odd", "odd", 3], ["ctrl", "ctl", 3], ["nonAscii", "nonA", 4],
    ["leaders", "lead", 4], ["pageNoPages", "pgNo", 4],
  ];
  const fmt = (v, w) => String(typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : (v ?? "")).slice(0, w).padStart(w);
  console.log(cols.map(([, h, w]) => h.padEnd(w)).join(" "));
  for (const r of rows) {
    console.log(r.error ? `${r.set.padEnd(10)} ${r.name.slice(0, 44).padEnd(44)} ERROR ${r.error}` : cols.map(([k, , w]) => (k === "set" || k === "name" ? String(r[k]).slice(0, w).padEnd(w) : fmt(r[k], w))).join(" "));
  }
  const ok = rows.filter((r) => !r.error);
  const sum = (k) => ok.reduce((a, r) => a + r[k], 0);
  console.log("");
  console.log(`fixtures ${rows.length} (errors ${rows.length - ok.length}) | pages ${sum("pages")} | chars ${sum("chars")} | lines ${sum("lines")}`);
  console.log(`empty/image-only pages ${sum("emptyPages")} | docs with zero text ${ok.filter((r) => r.chars === 0).length} | docs with column-merged rows ${ok.filter((r) => r.mergedRows).length} (${sum("mergedRows")} rows)`);
  console.log(`docs with repeated lines ${ok.filter((r) => r.repeated).length} | hyphen breaks ${sum("hyph")} | ligatures ${sum("ligatures")} | odd unicode ${sum("odd")} | control ${sum("ctrl")} | non-ASCII ${sum("nonAscii")} | dot-leader lines ${sum("leaders")}`);
  console.log(`docs with a page-number line ${ok.filter((r) => r.pageNoPages).length}`);
}

// DOCX path: build a synthetic .docx with LibreOffice, convert it to PDF with the flags lib/convert.ts uses, extract.
if (!args.has("--no-docx") && !args.has("--json")) {
  const soffice = process.env.SOFFICE_PATH || "soffice";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-audit-"));
  const run = (inp, fmt) => {
    const t0 = Date.now();
    const r = spawnSync(soffice, [`-env:UserInstallation=file://${dir}/profile`, "--headless", "--norestore", "--convert-to", fmt, "--outdir", dir, inp], {
      stdio: "ignore", timeout: 90_000, env: { PATH: process.env.PATH, HOME: dir, LANG: "en_US.UTF-8", SAL_USE_VCLPLUGIN: "svp" },
    });
    return { ok: r.status === 0, ms: Date.now() - t0, err: r.error?.code };
  };
  try {
    const html = path.join(dir, "sample.html");
    fs.writeFileSync(html, "<html><body><h1>Service Agreement</h1><p>Between Example Firm LLP and Client Name (client@example.test). The fee is $1,000 &mdash; payable &ldquo;within 30 days&rdquo;; the o&#xFB03;ce is closed.</p><table border=1><tr><td>Fee</td><td>$1,000</td></tr><tr><td>Term</td><td>12 months</td></tr></table><p>Signature: ____________________</p></body></html>");
    const a = run(html, "docx:MS Word 2007 XML");
    const docx = path.join(dir, "sample.docx");
    if (!a.ok || !fs.existsSync(docx)) console.log(`\nDOCX path: soffice unavailable or failed to build a sample (${a.err || "exit"}); not measured`);
    else {
      const b = run(docx, "pdf");
      const pdf = path.join(dir, "sample.pdf");
      if (!b.ok || !fs.existsSync(pdf)) console.log(`\nDOCX path: conversion failed after ${b.ms} ms`);
      else {
        const r = await audit(pdf);
        console.log(`\nDOCX path (synthetic, soffice ${b.ms} ms incl. cold start): pages ${r.pages}, chars ${r.chars}, lines ${r.lines}, col-merged rows ${r.mergedRows}, ligatures ${r.ligatures}, odd ${r.odd}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
