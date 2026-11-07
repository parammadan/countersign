// The evidence check. A finding is only "stated" if a quote from it is really in the document. This is what
// keeps an analyzer (a model in particular) from presenting something it made up, or something an instruction
// hidden in the agreement told it to say, as a fact from the agreement.
import type { Finding } from "./schema";
import { pageText, type PageLines } from "./text";

export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type Grounded = { findings: Finding[]; warnings: string[] };

export function groundFindings(findings: Finding[], pages: PageLines[]): Grounded {
  const texts = pages.map((p) => ({ page: p.page, text: normalize(pageText(p)) }));
  const warnings: string[] = [];
  let dropped = 0;
  let downgraded = 0;
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    let id = f.id;
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`.slice(0, 48);
    seen.add(id);
    const evidence: Finding["evidence"] = [];
    for (const e of f.evidence) {
      const q = normalize(e.quote);
      // on the page it names, or else on whichever page it's really on
      const hit = texts.find((t) => t.page === e.page && t.text.includes(q)) ?? texts.find((t) => t.text.includes(q));
      if (!hit) {
        dropped++;
        continue;
      }
      if (!evidence.some((x) => x.page === hit.page && normalize(x.quote) === q)) evidence.push({ page: hit.page, quote: e.quote.trim() });
    }
    let status = f.status;
    let note = f.note;
    if (status === "stated" && evidence.length === 0) {
      status = "inferred";
      note = "No supporting text was found in the document, so this isn't confirmed.";
      downgraded++;
    }
    out.push({ ...f, id, status, note, evidence, value: status === "missing" ? null : f.value });
  }
  if (dropped) warnings.push(`${dropped} quoted passage${dropped === 1 ? " wasn't" : "s weren't"} found in the document and ${dropped === 1 ? "was" : "were"} removed.`);
  if (downgraded) warnings.push(`${downgraded} finding${downgraded === 1 ? " was" : "s were"} marked inferred because nothing in the document supports ${downgraded === 1 ? "it" : "them"}.`);
  return { findings: out, warnings };
}
