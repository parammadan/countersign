// Hybrid drafting, behind HYBRID_DRAFTING=1 (off unless set). On a generated Studio draft: list every material
// requirement in the person's description, check which clauses state each one, and propose custom clauses for what
// the reviewed template can't state. Proposed clauses go in through the ordinary editor (versioned, editable,
// audited) and are recorded as AI-proposed and unreviewed: approving or publishing the draft is refused until an
// owner or admin has reviewed each one that is still in the draft. Tables are created if missing (no migration).
import { db } from "../db";
import { aiGate, estimateUsd } from "../ai/budget";
import { configuredProvider } from "../ai/anthropic";
import { GenerationError, generationProviderFrom } from "../drafts/provider";
import type { ModelProvider } from "../understand/model";
import type { DraftDocument } from "../m23/doc-output";
import {
  COVERAGE_SCHEMA, COVERAGE_SYSTEM, INVENTORY_SCHEMA, INVENTORY_SYSTEM, PROPOSE_SCHEMA, PROPOSE_SYSTEM,
  cleanCoverage, cleanInventory, cleanProposals, type CoverageItem, type DraftClause, type Requirement,
} from "./model";

type Session = { userId: string; workspaceId: string; role: "owner" | "admin" | "staff"; userEmail?: string; userName?: string };
type Drafts = typeof import("../drafts/service");

export const hybridEnabled = (env: Record<string, string | undefined> = process.env) => env.HYBRID_DRAFTING === "1";
const TYPICAL_USD = estimateUsd(16_000, 4_000);

const DDL = [
  "CREATE TABLE IF NOT EXISTS hybrid_runs (draft_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, description TEXT NOT NULL, requirements_json TEXT NOT NULL, coverage_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hybrid_clauses (draft_id TEXT NOT NULL, workspace_id TEXT NOT NULL, clause_id TEXT NOT NULL, requirement_ids_json TEXT NOT NULL, proposed_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT, PRIMARY KEY (draft_id, clause_id))",
];
let ready = false;
const ensure = () => {
  if (!ready) { for (const s of DDL) db().exec(s); ready = true; }
};
const now = () => new Date().toISOString();

export type HybridRun = { description: string; requirements: Requirement[]; coverage: CoverageItem[]; updatedAt: string };
export type AiClause = { clauseId: string; requirementIds: string[]; reviewed: boolean; reviewedAt: string | null };

/** The last run for a draft in this workspace (null when none). */
export function hybridRun(workspaceId: string, draftId: string): HybridRun | null {
  ensure();
  const r = db().prepare("SELECT description, requirements_json, coverage_json, updated_at FROM hybrid_runs WHERE draft_id = ? AND workspace_id = ?").get(draftId, workspaceId) as
    | { description: string; requirements_json: string; coverage_json: string; updated_at: string } | undefined;
  if (!r) return null;
  try {
    return { description: r.description, requirements: JSON.parse(r.requirements_json), coverage: JSON.parse(r.coverage_json), updatedAt: r.updated_at };
  } catch {
    return null;
  }
}

/** AI-proposed clauses recorded for a draft, limited to the ones still in the given document. */
export function aiClauses(workspaceId: string, draftId: string, doc: DraftDocument): AiClause[] {
  ensure();
  const present = new Set(doc.clauses.map((c) => c.id));
  return (db().prepare("SELECT clause_id, requirement_ids_json, reviewed_at FROM hybrid_clauses WHERE draft_id = ? AND workspace_id = ? ORDER BY proposed_at").all(draftId, workspaceId) as { clause_id: string; requirement_ids_json: string; reviewed_at: string | null }[])
    .filter((r) => present.has(r.clause_id))
    .map((r) => ({ clauseId: r.clause_id, requirementIds: JSON.parse(r.requirement_ids_json), reviewed: !!r.reviewed_at, reviewedAt: r.reviewed_at }));
}

/** Why approval or publishing must wait: AI-proposed clauses still in the draft that nobody has reviewed. */
export function unreviewedBlock(workspaceId: string, draftId: string, doc: DraftDocument): string | null {
  const n = aiClauses(workspaceId, draftId, doc).filter((c) => !c.reviewed).length;
  return n ? `${n} AI-proposed ${n === 1 ? "clause needs" : "clauses need"} review by an owner or admin before this draft can be approved or published.` : null;
}

const asClauses = (doc: DraftDocument): DraftClause[] =>
  doc.clauses.map((c, i) => ({ id: c.id, number: c.number ?? String(i + 1), heading: c.heading ?? "", text: c.text }));

export type HybridResult =
  | { ok: true; requirements: number; included: number; proposed: number; run: HybridRun }
  | { ok: false; code: "off" | "invalid" | "ai_off" | "unverified" | "spend_cap" | "failed" | "not_found" | "stale" | "forbidden"; message: string };

/**
 * Run the requirement check on a draft and propose clauses for what it doesn't state. The person must be able to
 * edit the draft (the editor enforces it). Every model step is metered under the "hybrid" feature.
 */
export async function runHybrid(s: Session, draftId: string, description: string, model: ModelProvider | null = configuredProvider(), drafts?: Drafts): Promise<HybridResult> {
  if (!hybridEnabled()) return { ok: false, code: "off", message: "Requirement checking isn't switched on for this server." };
  const svc = drafts ?? (await import("../drafts/service"));
  const text = description.trim();
  if (text.length < 10 || text.length > 4_000) return { ok: false, code: "invalid", message: "Paste the description you generated this draft from (10 to 4,000 characters)." };
  const g = svc.getDraft(s as never, draftId);
  if (!g.ok) return { ok: false, code: "not_found", message: "That draft wasn't found." };
  if (s.role === "staff" && (g.draft as { created_by?: string }).created_by !== s.userId) return { ok: false, code: "forbidden", message: "Only the draft's author, an owner or an admin can do this." };
  const gate = aiGate("hybrid", s.workspaceId, model, TYPICAL_USD);
  if (!gate.provider) return { ok: false, code: (gate.reason as "unverified" | "spend_cap" | undefined) ?? "ai_off", message: gate.notice ?? "AI isn't available on this server." };
  const p = generationProviderFrom(gate.provider, { maxOutputTokens: 4_000 });
  const call = (system: string, payload: unknown, schema: object) => p.complete({ system, prompt: JSON.stringify(payload), schema });
  try {
    const requirements = cleanInventory(await call(INVENTORY_SYSTEM, { description: text }, INVENTORY_SCHEMA), text);
    if (!requirements.length) return { ok: false, code: "failed", message: "No requirements could be read from that description." };
    let doc = g.version.doc as DraftDocument;
    let expected = g.version.number;
    let coverage = cleanCoverage(await call(COVERAGE_SYSTEM, { requirements, clauses: asClauses(doc) }, COVERAGE_SCHEMA), requirements, asClauses(doc));
    // only what the draft doesn't state, or states in part; a requirement it states differently ("changed") goes to
    // a person to clarify, never to a second, conflicting clause
    const wanted = requirements.filter((r) => ["not_included", "partial"].includes(coverage.find((c) => c.id === r.id)!.status));
    let proposed = 0;
    if (wanted.length) {
      const proposals = cleanProposals(await call(PROPOSE_SYSTEM, { agreement: doc.title, parties: doc.parties, existingClauses: asClauses(doc).map(({ number, heading, text }) => ({ number, heading, text })), requirements: wanted }, PROPOSE_SCHEMA), wanted);
      ensure();
      for (const pr of proposals) {
        // before the locked signature clause, after everything else
        const sig = doc.clauses.findIndex((c) => c.locked);
        const after = doc.clauses[sig > 0 ? sig - 1 : doc.clauses.length - 1].id;
        const before = new Set(doc.clauses.map((c) => c.id));
        const r = svc.editDraft(s as never, draftId, expected, { op: "add_clause", after, text: pr.text, heading: pr.heading });
        if (!r.ok) continue; // a clause the editor refuses (length, limits) is skipped, not forced in
        const fresh = svc.getDraft(s as never, draftId);
        if (!fresh.ok) break;
        doc = fresh.version.doc as DraftDocument;
        expected = fresh.version.number;
        const added = doc.clauses.find((c) => !before.has(c.id));
        if (!added) continue;
        db().prepare("INSERT OR REPLACE INTO hybrid_clauses (draft_id, workspace_id, clause_id, requirement_ids_json, proposed_at) VALUES (?, ?, ?, ?, ?)").run(draftId, s.workspaceId, added.id, JSON.stringify(pr.requirementIds), now());
        proposed++;
      }
      if (proposed) coverage = cleanCoverage(await call(COVERAGE_SYSTEM, { requirements, clauses: asClauses(doc) }, COVERAGE_SCHEMA), requirements, asClauses(doc));
    }
    ensure();
    const at = now();
    db().prepare("INSERT OR REPLACE INTO hybrid_runs (draft_id, workspace_id, description, requirements_json, coverage_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(draftId, s.workspaceId, text, JSON.stringify(requirements), JSON.stringify(coverage), at);
    return { ok: true, requirements: requirements.length, included: coverage.filter((c) => c.status === "included").length, proposed, run: { description: text, requirements, coverage, updatedAt: at } };
  } catch (e) {
    if (gate.capped()) return { ok: false, code: "spend_cap", message: "AI isn't available right now (daily limit)." };
    return { ok: false, code: "failed", message: e instanceof GenerationError && e.kind === "cut_off" ? "Claude's answer was cut off; try a shorter description." : "Claude didn't answer. Try again." };
  }
}

/** An owner or admin marks an AI-proposed clause as reviewed (it stays editable; the review is recorded). */
export function reviewAiClause(s: Session, draftId: string, clauseId: string, drafts: Drafts): { ok: true } | { ok: false; message: string } {
  if (s.role === "staff") return { ok: false, message: "Only an owner or admin can review AI-proposed clauses." };
  const g = drafts.getDraft(s as never, draftId);
  if (!g.ok) return { ok: false, message: "That draft wasn't found." };
  if (!aiClauses(s.workspaceId, draftId, g.version.doc as DraftDocument).some((c) => c.clauseId === clauseId)) return { ok: false, message: "That clause isn't an AI-proposed clause in this draft." };
  db().prepare("UPDATE hybrid_clauses SET reviewed_by = ?, reviewed_at = ? WHERE draft_id = ? AND workspace_id = ? AND clause_id = ?").run(s.userId, now(), draftId, s.workspaceId, clauseId);
  return { ok: true };
}
