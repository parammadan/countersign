import { createHash } from "node:crypto";
import { chunkPage, extractValues, tokenize } from "./text";
import type {
  Access,
  AddResult,
  Citation,
  DocumentInput,
  IndexStats,
  RetrievalIndex,
  SearchInput,
  SearchResult,
} from "./types";

export type * from "./types";

const K1 = 1.2;
const B = 0.75;
/** Share of the query's distinct terms a chunk must contain to count as evidence. */
const MIN_COVERAGE = 0.6;
const DEFAULT_K = 5;
const MAX_K = 50;

type Chunk = {
  id: string;
  page: number;
  text: string;
  sentences: { start: number; end: number }[];
  terms: Map<string, number>;
  length: number;
};

/** Indexed content, stored once per workspace however many documents carry it. */
type Content = { hash: string; chunks: Chunk[]; refs: Set<string> };
type Doc = { docId: string; title: string; version: number; access: Access; hash: string };
type Workspace = { docs: Map<string, Doc>; contents: Map<string, Content> };

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return v;
}

function cleanAccess(a: Access): Access {
  if (!a || typeof a !== "object") throw new TypeError("access must be an object");
  const list = (x: unknown, name: string) => {
    if (x === undefined) return undefined;
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new TypeError(`access.${name} must be string[]`);
    return [...x] as string[];
  };
  return { roles: list(a.roles, "roles"), userIds: list(a.userIds, "userIds") };
}

function canSee(access: Access, user: { id: string; role: string }): boolean {
  return !!(access.roles?.includes("*") || access.roles?.includes(user.role) || access.userIds?.includes(user.id));
}

function contentHash(pages: string[]): string {
  return createHash("sha256").update(JSON.stringify(pages)).digest("hex");
}

function buildContent(hash: string, pages: string[]): Content {
  const chunks: Chunk[] = [];
  pages.forEach((page, pi) => {
    chunkPage(page).forEach((c, ci) => {
      const terms = new Map<string, number>();
      const toks = tokenize(c.text);
      for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1);
      chunks.push({
        id: `${hash.slice(0, 12)}:p${pi + 1}:c${ci}`,
        page: pi + 1,
        text: c.text,
        sentences: c.sentences,
        terms,
        length: toks.length,
      });
    });
  });
  return { hash, chunks, refs: new Set() };
}

export function createIndex(): RetrievalIndex {
  const workspaces = new Map<string, Workspace>();
  const ws = (id: string, create = false): Workspace | undefined => {
    let w = workspaces.get(id);
    if (!w && create) workspaces.set(id, (w = { docs: new Map(), contents: new Map() }));
    return w;
  };
  const unref = (w: Workspace, doc: Doc) => {
    const c = w.contents.get(doc.hash);
    if (!c) return;
    c.refs.delete(doc.docId);
    if (c.refs.size === 0) w.contents.delete(doc.hash);
  };

  return {
    /**
     * For trusted ingestion code only: `duplicateOf` can name a document the caller's end user may not see, so
     * never relay an AddResult to an end user. Re-adding the same version and content is a no-op, so title and
     * access changes are ignored (use a higher version or updateAccess).
     */
    addDocument(input: DocumentInput): AddResult {
      const workspaceId = str(input.workspaceId, "workspaceId");
      const docId = str(input.docId, "docId");
      const title = str(input.title, "title");
      if (!Number.isFinite(input.version)) throw new TypeError("version must be a finite number");
      if (!Array.isArray(input.pages) || input.pages.some((p) => typeof p !== "string"))
        throw new TypeError("pages must be string[]");
      const access = cleanAccess(input.access);
      const hash = contentHash(input.pages);
      const w = ws(workspaceId, true)!;

      const old = w.docs.get(docId);
      let status: AddResult["status"] = "added";
      if (old) {
        if (input.version < old.version || (input.version === old.version && hash !== old.hash))
          return { status: "stale", docId };
        if (input.version === old.version) return { status: "unchanged", docId };
        status = "replaced";
        unref(w, old);
      }
      let content = w.contents.get(hash);
      let duplicateOf: string | undefined;
      if (content) {
        duplicateOf = [...content.refs].sort()[0];
        if (status === "added") status = "duplicate";
      } else {
        content = buildContent(hash, input.pages);
        w.contents.set(hash, content);
      }
      content.refs.add(docId);
      w.docs.set(docId, { docId, title, version: input.version, access, hash });
      return status === "duplicate" ? { status, docId, duplicateOf } : { status, docId };
    },

    removeDocument(workspaceId, docId) {
      const w = ws(workspaceId);
      const doc = w?.docs.get(docId);
      if (!w || !doc) return false;
      w.docs.delete(docId);
      unref(w, doc);
      return true;
    },

    updateAccess(workspaceId, docId, access) {
      const doc = ws(workspaceId)?.docs.get(docId);
      if (!doc) return false;
      doc.access = cleanAccess(access);
      return true;
    },

    stats(workspaceId): IndexStats {
      const w = ws(workspaceId);
      if (!w) return { documents: 0, chunks: 0 };
      let chunks = 0;
      for (const c of w.contents.values()) chunks += c.chunks.length;
      return { documents: w.docs.size, chunks };
    },

    search(input: SearchInput): SearchResult {
      const workspaceId = str(input.workspaceId, "workspaceId");
      const user = { id: str(input.user?.id, "user.id"), role: str(input.user?.role, "user.role") };
      const query = typeof input.query === "string" ? input.query : "";
      const rawK = Math.floor(Number(input.k ?? DEFAULT_K));
      const k = Number.isFinite(rawK) ? Math.min(MAX_K, Math.max(1, rawK)) : DEFAULT_K;
      const none: SearchResult = { status: "no_evidence", results: [] };
      const w = ws(workspaceId);
      if (!w) return none;

      // 1. Filter first: only chunks of documents this user may see take part in scoring and statistics.
      type Visible = { chunk: Chunk; doc: Doc };
      const visible: Visible[] = [];
      for (const content of w.contents.values()) {
        const docs = [...content.refs]
          .map((id) => w.docs.get(id)!)
          .filter((d) => canSee(d.access, user))
          .sort((a, b) => (a.docId < b.docId ? -1 : 1));
        if (!docs.length) continue;
        for (const chunk of content.chunks) visible.push({ chunk, doc: docs[0] });
      }
      const qTerms = [...new Set(tokenize(query))];
      if (!qTerms.length || !visible.length) return none;

      // 2. BM25 over the visible set only.
      const N = visible.length;
      const avgLen = visible.reduce((s, v) => s + v.chunk.length, 0) / N || 1;
      const df = new Map<string, number>();
      for (const t of qTerms) df.set(t, visible.reduce((n, v) => n + (v.chunk.terms.has(t) ? 1 : 0), 0));
      const scored: { v: Visible; score: number; matched: string[] }[] = [];
      for (const v of visible) {
        let score = 0;
        const matched: string[] = [];
        for (const t of qTerms) {
          const tf = v.chunk.terms.get(t);
          if (!tf) continue;
          matched.push(t);
          const n = df.get(t)!;
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * v.chunk.length) / avgLen));
        }
        if (matched.length / qTerms.length >= MIN_COVERAGE) scored.push({ v, score, matched });
      }
      if (!scored.length) return none;
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          (a.v.doc.docId < b.v.doc.docId ? -1 : a.v.doc.docId > b.v.doc.docId ? 1 : 0) ||
          a.v.chunk.page - b.v.chunk.page ||
          (a.v.chunk.id < b.v.chunk.id ? -1 : 1),
      );

      const quoteOf = (c: Chunk, terms: string[]) => {
        let best = c.sentences[0];
        let bestN = -1;
        for (const s of c.sentences) {
          const set = new Set(tokenize(c.text.slice(s.start, s.end)));
          const n = terms.filter((t) => set.has(t)).length;
          if (n > bestN) {
            best = s;
            bestN = n;
          }
        }
        return { quote: c.text.slice(best.start, best.end), covered: bestN };
      };
      // Always look at the best MAX_K so the ambiguity verdict does not depend on the caller's k.
      const top = scored.slice(0, MAX_K).map((s) => {
        const { quote, covered } = quoteOf(s.v.chunk, qTerms);
        const citation: Citation = {
          docId: s.v.doc.docId,
          title: s.v.doc.title,
          page: s.v.chunk.page,
          chunkId: s.v.chunk.id,
          text: s.v.chunk.text,
          quote,
          score: s.score,
        };
        return { citation, covered };
      });

      // 3. Ambiguity: another document's best sentence covers the query as well as the top one's and gives a
      // different amount for the same unit ("30 days" vs "45 days").
      const first = top[0];
      if (!first) return none;
      const need = Math.ceil(MIN_COVERAGE * qTerms.length);
      if (first.covered >= need) {
        const firstVals = extractValues(first.citation.quote);
        const conflicting = top.slice(1).filter((o) => {
          if (o.covered < need || o.citation.docId === first.citation.docId) return false;
          const vals = extractValues(o.citation.quote);
          return firstVals.some(
            (a) =>
              vals.some((b) => b.unit === a.unit) &&
              !vals.some((b) => b.unit === a.unit && b.amount === a.amount),
          );
        });
        if (conflicting.length)
          return { status: "ambiguous", results: [first, ...conflicting].map((x) => x.citation) };
      }
      return { status: "ok", results: top.slice(0, k).map((x) => x.citation) };
    },
  };
}
