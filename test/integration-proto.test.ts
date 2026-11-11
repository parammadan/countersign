// LOCAL PROTOTYPE (not committed): can sandbox Q12 (retrieval) and Q13 (eval harness) plug into M2.1/M2.2 as is?
// No network and no paid model: the "model" answerers are fake providers built from Q13's gold data.
import { describe, it, expect } from "vitest";
import { answerFromPassages, answerWithModel } from "@/lib/qa/answer";
import { passages, retrieve, QA_INSTRUCTION_RE } from "@/lib/qa/retrieve";
import { linesFromText } from "@/lib/understand/text";
import { normalize as m21normalize } from "@/lib/understand/evidence";
import type { ModelProvider } from "@/lib/understand/model";
import { createIndex } from "@/retrieval/index";
// @ts-expect-error plain .mjs without types
import { loadCases } from "@/evals/dataset.mjs";
// @ts-expect-error plain .mjs without types
import { scoreRun, quoteOnPage } from "@/evals/metrics.mjs";
// @ts-expect-error plain .mjs without types
import { normalize as q13normalize, containsFact } from "@/evals/text.mjs";

type Fact = string | string[];
type Case = {
  id: string; category: string; question: string; documents: { id: string; pages: string[] }[];
  gold: { status: string; answer: string; facts: Fact[]; distractors: Fact[]; sources: { docId: string; page: number; quote: string }[]; traps: string[] };
};
type Out = { status: string; answer: string; citations: { docId: string; page: number; quote: string }[] };

const ALL: Case[] = loadCases();
const SINGLE = ALL.filter((c) => c.documents.length === 1);
const MULTI = ALL.filter((c) => c.documents.length > 1);
const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const fmt = (o: Record<string, number | null>) =>
  ["citationAccuracy", "sourceRecall", "factualRecall", "factualPrecision", "unsupportedClaimRate", "abstentionPrecision", "abstentionRecall", "trapLeakRate"]
    .map((k) => `${k}=${pct(o[k] as number | null)}`).join(" ");

const toQ13 = (docId: string, r: { status: string; answer: string; citations: { page: number; quote: string }[] }): Out => ({
  status: r.status, answer: r.answer, citations: r.citations.map((c) => ({ docId, page: c.page, quote: c.quote })),
});

// a fake provider that answers from what it is given in <passage> tags
function provider(answer: (ps: { id: string; text: string }[]) => unknown): ModelProvider {
  return {
    name: "fake", model: "fake",
    complete: async (r) => {
      const ps = [...r.document.matchAll(/<passage id="([^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
      return answer(ps);
    },
  };
}
const words = (f: Fact) => (Array.isArray(f) ? f[0] : f);

describe("prototype: Q13 harness over M2.2", () => {
  it("M2.2 passages mode (the production default) on Q13's single-document cases", async () => {
    const answers = SINGLE.map((c) => toQ13(c.documents[0].id, answerFromPassages(c.question, linesFromText(c.documents[0].pages))));
    const r = scoreRun(SINGLE, answers);
    console.log(`[A] passages mode, ${SINGLE.length} single-doc cases: ${fmt(r.overall)}`);
    for (const [k, v] of Object.entries(r.byCategory)) console.log(`    ${k}: ${fmt(v as Record<string, number | null>)}`);
    expect(r.overall.citationAccuracy).toBe(1);
  });

  it("M2.2 model path with a gold-answer model: how often does the validator withhold a correct answer?", async () => {
    const answers: Out[] = [];
    let goldQuoteMissing = 0;
    for (const c of SINGLE) {
      const p = provider((ps) => {
        if (c.gold.status === "not_found") return { status: "not_found", answer: "Not found.", citations: [] };
        const cites = c.gold.sources.map((s) => {
          const hit = ps.find((x) => m21normalize(x.text).includes(m21normalize(s.quote)));
          if (!hit) goldQuoteMissing++;
          return hit ? { passage: hit.id, quote: s.quote } : null;
        }).filter(Boolean);
        return { status: c.gold.status, answer: c.gold.answer, citations: cites };
      });
      answers.push(toQ13(c.documents[0].id, await answerWithModel(p, c.question, linesFromText(c.documents[0].pages))));
    }
    const r = scoreRun(SINGLE, answers);
    const answerable = SINGLE.map((c, i) => [c, answers[i]] as const).filter(([c]) => c.gold.status !== "not_found");
    const kept = answerable.filter(([c, a]) => a.status !== "not_found" && c.gold.facts.every((f) => containsFact(a.answer, f))).length;
    console.log(`[B] gold-answer model: correct answers shown ${kept}/${answerable.length}; gold quote not in retrieved context ${goldQuoteMissing}; ${fmt(r.overall)}`);
    expect(r.overall.citationAccuracy).toBe(1);
  });

  it("M2.2 model path with an adversarial model (traps and distractor swaps, validly cited)", async () => {
    let trapCases = 0, trapLeaks = 0, swapCases = 0, swapShown = 0;
    for (const c of SINGLE) {
      const pages = linesFromText(c.documents[0].pages);
      for (const trap of c.gold.traps) {
        trapCases++;
        const p = provider((ps) => {
          const planted = ps.find((x) => q13normalize(x.text).includes(q13normalize(trap)));
          const cite = planted ?? ps[0];
          return { status: "answered", answer: `According to the agreement, the ${trap}.`, citations: cite ? [{ passage: cite.id, quote: cite.text.slice(0, 120) }] : [] };
        });
        const out = await answerWithModel(p, c.question, pages);
        if (q13normalize(out.answer).includes(q13normalize(trap))) trapLeaks++;
      }
      // the known limitation: a wrong value that exists in a cited passage
      const fact = c.gold.facts[0];
      const wrong = c.gold.distractors[0];
      if (c.gold.status !== "not_found" && fact && wrong) {
        swapCases++;
        const p = provider((ps) => {
          const where = ps.filter((x) => containsFact(x.text, wrong) || containsFact(x.text, fact));
          return { status: "answered", answer: c.gold.answer.split(words(fact)).join(words(wrong)), citations: where.slice(0, 3).map((x) => ({ passage: x.id, quote: x.text.slice(0, 200) })) };
        });
        const out = await answerWithModel(p, c.question, pages);
        if (out.answer.includes(words(wrong)) && !out.answer.includes(words(fact))) swapShown++;
      }
    }
    console.log(`[C] adversarial model: trap leaks ${trapLeaks}/${trapCases}; wrong-value swaps shown ${swapShown}/${swapCases}`);
    expect(trapLeaks).toBe(0);
  });
});

describe("prototype: Q12 index against M2.1/M2.2 rules and Q13's (unseen) cases", () => {
  it("citations are verbatim under both M2.1's and Q13's checks; planted text is not filtered", () => {
    let cites = 0, m21ok = 0, q13ok = 0, plantedCited = 0, pageHit = 0, answerable = 0, m22PageHit = 0;
    let abstainAgree = 0;
    for (const c of SINGLE) {
      const idx = createIndex();
      const d = c.documents[0];
      idx.addDocument({ workspaceId: "w", docId: d.id, title: d.id, version: 1, pages: d.pages, access: { roles: ["*"] } });
      const r = idx.search({ workspaceId: "w", user: { id: "u", role: "member" }, query: c.question, k: 3 });
      for (const x of r.results) {
        cites++;
        if (m21normalize(d.pages[x.page - 1]).includes(m21normalize(x.quote))) m21ok++;
        if (quoteOnPage(c.documents, { docId: x.docId, page: x.page, quote: x.quote })) q13ok++;
        if (QA_INSTRUCTION_RE.test(m21normalize(x.text))) plantedCited++;
      }
      if ((r.status === "no_evidence") === (c.gold.status === "not_found")) abstainAgree++;
      if (c.gold.status !== "not_found" && c.gold.sources.length) {
        answerable++;
        const gold = new Set(c.gold.sources.map((s) => s.page));
        if (r.results.some((x) => gold.has(x.page))) pageHit++;
        const top = retrieve(c.question, passages(linesFromText(d.pages)).passages, { k: 3 });
        if (top.some((p) => gold.has(p.page))) m22PageHit++;
      }
    }
    console.log(`[D] Q12 on ${SINGLE.length} unseen single-doc cases: citations ${cites}, verbatim M2.1 ${m21ok}, Q13 ${q13ok}; planted-instruction chunks cited ${plantedCited}; gold page in top 3: Q12 ${pageHit}/${answerable} vs M2.2 retrieve ${m22PageHit}/${answerable}; abstain agreement ${abstainAgree}/${SINGLE.length}`);
    expect(m21ok).toBe(cites);
  });

  it("multi-document and contradiction cases (M3 territory): Q12 across two documents", () => {
    let contra = 0, flagged = 0, bothCited = 0;
    for (const c of MULTI) {
      const idx = createIndex();
      for (const d of c.documents) idx.addDocument({ workspaceId: "w", docId: d.id, title: d.id, version: 1, pages: d.pages, access: { roles: ["*"] } });
      const r = idx.search({ workspaceId: "w", user: { id: "u", role: "member" }, query: c.question, k: 5 });
      const docs = new Set(r.results.map((x) => x.docId));
      if (c.category === "contradiction") {
        contra++;
        if (r.status === "ambiguous") flagged++;
      }
      if (c.gold.sources.every((s) => docs.has(s.docId))) bothCited++;
    }
    console.log(`[E] Q12 multi-doc: ${MULTI.length} cases, all gold documents cited ${bothCited}/${MULTI.length}; contradictions flagged ambiguous ${flagged}/${contra}`);
    expect(MULTI.length).toBeGreaterThan(0);
  });
});
