// M4 Document Intelligence: the server-side glue between the session, the reviewed intake rules (lib/intake/intake,
// from S7), the intake store and the internal workflow outbox (lib/workflow, from S16).
//
// Trust rules:
// - Every call takes the server session; nothing about the workspace, role or user comes from the request.
// - Intake is rules only. No model is called (the module's optional tie-break is not wired), so nothing paid runs
//   and nothing a model says can route a document to ready_to_prepare.
// - Results are stored per workspace and read back only for the session's workspace.
// - Workflow events are internal: recorded with no targets, never delivered (lib/workflow/app.ts).
import { ACCEPTED, ConvertError, toPdf } from "../convert";
import { extractPdf } from "../pdf/extract";
import { id as newId, sha256 } from "../util";
import { analyzeDocument, pagesForModel } from "./intake";
import { pagesFromExtraction } from "./pages";
import { getResult, insertResult, latestAnalysisRow, listResults, markDraftStarted, runsSince, type IntakeResult, type IntakeRow } from "./store";
import type { IntakeRecord } from "./types";
import { appOutbox, listEvents, recordEvent, syncStudioEvents, type EventView } from "../workflow/app";
import { runPipeline } from "../workflow/m4-pipeline";
import type { GenerateInput, Kind, TermKey } from "../m23/m23-generate/types";
import { TEMPLATES } from "../m23/m23-generate";
import { createDraft, kindSpecs, type Clarifications } from "../drafts/service";
import { termName } from "../drafts/labels";
import { numbersIn } from "../qa/numbers";
import { normalize } from "../understand/evidence";
import type { DocAnalysis, DocDraft, DraftSource } from "./ai";

export type SessionLike = { userId: string; workspaceId: string; role: "owner" | "admin" | "staff" };

/** Server actions accept request bodies up to 2 MB (next.config.ts, owner-reserved), so uploads here stop below that. */
export const MAX_INTAKE_UPLOAD = 1_900_000;
export const MAX_PASTE_CHARS = 200_000;
export const RUNS_PER_HOUR = 30;

export type Failure = { ok: false; code: "forbidden" | "invalid" | "too_large" | "limit" | "unreadable"; message: string };
const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

const isMember = (s: SessionLike) => !!s && typeof s.workspaceId === "string" && !!s.workspaceId && typeof s.userId === "string" && ["owner", "admin", "staff"].includes(s.role);
const isAdmin = (s: SessionLike) => isMember(s) && s.role !== "staff";

export type IntakeInput =
  | { kind: "paste"; text: string; title?: string }
  | { kind: "upload"; data: Buffer; filename: string };

/** Runs in progress per workspace: a slot is taken before the first await, so concurrent requests can't all pass the limit. */
const inFlight = new Map<string, number>();

/** Read a document (an upload or pasted text), run the intake rules, store the record and record workflow events. */
export async function runIntake(s: SessionLike, input: IntakeInput): Promise<{ ok: true; id: string; decision: IntakeRecord["routing"]["decision"] } | Failure> {
  if (!isMember(s)) return fail("forbidden", "Sign in to a workspace first.");
  const ws = s.workspaceId;
  // check and reserve synchronously (no await in between); the slot is released when the run ends, stored or not
  const busy = inFlight.get(ws) ?? 0;
  if (runsSince(ws, new Date(Date.now() - 3600_000).toISOString()) + busy >= RUNS_PER_HOUR)
    return fail("limit", `This workspace has read ${RUNS_PER_HOUR} documents in the last hour, the current limit. Try again later.`);
  inFlight.set(ws, busy + 1);
  try {
    return await readAndStore(s, input);
  } finally {
    const n = (inFlight.get(ws) ?? 1) - 1;
    if (n > 0) inFlight.set(ws, n);
    else inFlight.delete(ws);
  }
}

async function readAndStore(s: SessionLike, input: IntakeInput): Promise<{ ok: true; id: string; decision: IntakeRecord["routing"]["decision"] } | Failure> {
  let pages: string[];
  let filename: string | null = null;
  let source: "upload" | "paste";
  if (input?.kind === "paste") {
    source = "paste";
    if (typeof input.text !== "string" || !input.text.trim()) return fail("invalid", "Paste the document's text first.");
    if (input.text.length > MAX_PASTE_CHARS) return fail("too_large", `Paste up to ${MAX_PASTE_CHARS.toLocaleString("en-US")} characters, or upload the file instead.`);
    // a form feed separates pages, as in text exported from a PDF
    pages = input.text.split("\f");
    const t = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
    filename = t || null;
  } else if (input?.kind === "upload") {
    source = "upload";
    const name = typeof input.filename === "string" ? input.filename.slice(0, 200) : "";
    if (!Buffer.isBuffer(input.data) || input.data.length === 0) return fail("invalid", "That file is empty.");
    if (input.data.length > MAX_INTAKE_UPLOAD) return fail("too_large", "Files up to 1.9 MB can be read here. Paste the text instead, or save a smaller PDF.");
    const ext = (name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase();
    const isPdf = input.data.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!isPdf && !ACCEPTED.includes(ext)) return fail("invalid", "Upload a PDF or Word document (.pdf, .docx, .doc, .odt, .rtf).");
    filename = name || "document";
    let pdf: Buffer;
    try {
      pdf = await toPdf(input.data, name || "document.pdf");
    } catch (e) {
      if (e instanceof ConvertError) return fail("unreadable", e.message);
      throw e;
    }
    try {
      pages = pagesFromExtraction(await extractPdf(new Uint8Array(pdf)));
    } catch {
      return fail("unreadable", "We couldn't read the text in this PDF. Try exporting it again, or paste the text.");
    }
  } else return fail("invalid", "Upload a file or paste the text.");

  const doc = { pages, metadata: filename ? { filename } : undefined };
  const record = analyzeDocument(doc);
  // the text AI may read later (quarantined lines blanked); kept with the record, in this workspace only
  const modelPages = pagesForModel(doc);
  const id = newId("int_");
  insertResult(s.workspaceId, { id, createdBy: s.userId, createdAt: new Date().toISOString(), source, filename, textSha256: sha256(pages.join("\f")), record, modelPages });
  recordIntakeEvents(s.workspaceId, id, record, source);
  return { ok: true, id, decision: record.routing.decision };
}

/** intake.completed for every document, plus S16's verified pipeline action (prepare or review task) when allowed. */
function recordIntakeEvents(workspaceId: string, id: string, record: IntakeRecord, source: "upload" | "paste"): void {
  try {
    recordEvent(
      workspaceId,
      "intake.completed",
      {
        intakeId: id, source, documentType: record.documentType.type, decision: record.routing.decision,
        conflicts: record.conflicts.length, missing: record.missing.length, warnings: record.warnings.length, quarantined: record.injection.length,
      },
      `intake:${id}`,
    );
    runPipeline(appOutbox(), { workspaceId, fileId: id, record }, []);
  } catch (e) {
    // the result is stored either way; an event that could not be recorded is logged, never shown as recorded
    console.error("intake: workflow event not recorded", e instanceof Error ? e.message : e);
  }
}

export function listIntakes(s: SessionLike): { ok: true; results: IntakeRow[] } | Failure {
  if (!isMember(s)) return fail("forbidden", "Sign in to a workspace first.");
  return { ok: true, results: listResults(s.workspaceId) };
}

export function getIntake(s: SessionLike, id: string): { ok: true; result: IntakeResult } | Failure {
  if (!isMember(s)) return fail("forbidden", "Sign in to a workspace first.");
  const r = typeof id === "string" && id.length <= 100 ? getResult(s.workspaceId, id) : null;
  return r ? { ok: true, result: r } : fail("invalid", "Document not found in this workspace.");
}

// ---------- Agreement Studio pre-fill: extracted values only, for the user to confirm ----------

export type Prefill = {
  kind: Kind | null;
  names: Record<string, string>;
  terms: Partial<Record<TermKey, string>>;
  /** Fields left empty on purpose (conflicting values, or no matching form field), for the page to say so. */
  notes: string[];
  /** Values only Claude's analysis read (each supported by its own quote), shown marked for the person to check. */
  ai?: { names: Record<string, string>; terms: Partial<Record<TermKey, string>>; sources: DraftSource[] };
  /** Studio's structured clarifications from the analysis: needed / optional / what the template can't include. */
  clarifications?: Clarifications;
};

const KIND_OF: Partial<Record<IntakeRecord["documentType"]["type"], Kind>> = { services: "services", nda: "nda", lease: "lease" };
// intake role words (lower case) that name the same party as a Studio role
const ROLE_ALIAS: Record<string, string> = { provider: "Provider", "service provider": "Provider", consultant: "Provider", contractor: "Provider", client: "Client", customer: "Client", "disclosing party": "Disclosing Party", "receiving party": "Receiving Party", landlord: "Landlord", tenant: "Tenant" };
/** The template's role for an intake role word: its own role name, or the providing party of a template with a Client. */
function templateRoleOf(kind: Kind, word: string): string | null {
  const roles = TEMPLATES[kind].roles;
  const w = word.trim().toLowerCase();
  const direct = roles.find((r) => r.toLowerCase() === w);
  if (direct) return direct;
  const canon = ROLE_ALIAS[w];
  if (!canon) return null;
  if (roles.includes(canon)) return canon;
  return canon === "Provider" && roles[1] === "Client" ? roles[0] : null;
}

/**
 * The Studio form values an intake record supports, and nothing else: each value is copied from the record's
 * extracted values (never inferred), and a field with conflicting values is left empty. The user confirms every
 * value before anything is generated. `kindOverride`: the template to fill (from the AI analysis), else the rules' type.
 */
export function draftPrefill(record: IntakeRecord, kindOverride?: Kind): Prefill {
  return rulesPrefill(record, kindOverride).prefill;
}

/** draftPrefill, plus the fields left empty on purpose because the document conflicts ("role:<Role>", "term:<key>"). */
function rulesPrefill(record: IntakeRecord, kindOverride?: Kind): { prefill: Prefill; held: string[] } {
  const notes: string[] = [];
  const held: string[] = [];
  const kind = kindOverride ?? KIND_OF[record.documentType.type] ?? null;
  if (!kind) return { prefill: { kind: null, names: {}, terms: {}, notes: ["The document type has no Agreement Studio template, so choose one; no values were copied."] }, held };
  const accepts = new Set(kindSpecs().find((k) => k.kind === kind)?.terms.map((t) => t.key) ?? []);
  const conflicted = new Set(record.conflicts.map((c) => c.field));
  const names: Record<string, string> = {};
  for (const role of TEMPLATES[kind].roles) {
    const found = record.parties.filter((p) => p.value.role && templateRoleOf(kind, p.value.role) === role);
    const distinct = [...new Set(found.map((p) => p.value.name))];
    const inConflict = found.some((p) => conflicted.has(`parties.${p.value.role}`));
    if (distinct.length === 1 && !inConflict) names[role] = distinct[0];
    else if (distinct.length > 1 || inConflict) {
      notes.push(`${role}: the document names more than one party for this role, so it was left empty.`);
      held.push(`role:${role}`);
    }
  }
  const terms: Partial<Record<TermKey, string>> = {};
  const single = <T,>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);
  if (!conflicted.has("governingLaw")) {
    const law = single(record.governingLaw.map((g) => g.value));
    if (law) terms.governingLaw = law;
  } else {
    notes.push("Governing law: the document gives more than one, so it was left empty.");
    held.push("term:governingLaw");
  }
  const dateOf = (kinds: string[], key: TermKey) => {
    if (kinds.some((k) => conflicted.has(`dates.${k}`))) {
      held.push(`term:${key}`);
      return undefined;
    }
    return single([...new Set(record.dates.filter((d) => kinds.includes(d.value.kind)).map((d) => d.value.iso))]);
  };
  const start = dateOf(["effective", "start"], "startDate");
  if (start) terms.startDate = start;
  if (kind === "lease") {
    const end = dateOf(["end"], "endDate");
    if (end) terms.endDate = end;
  }
  const amountOf = (label: string, key: TermKey) => {
    if (conflicted.has(`amounts.${label}`)) {
      notes.push(`${label}: the document gives more than one figure, so it was left empty.`);
      held.push(`term:${key}`);
      return undefined;
    }
    return single([...new Set(record.amounts.filter((a) => a.value.label === label).map((a) => a.value.raw.trim()))]);
  };
  if (kind !== "lease" && accepts.has("fee")) {
    const fee = amountOf("fee", "fee");
    if (fee) terms.fee = fee;
  }
  if (kind === "lease") {
    const rent = amountOf("rent", "rent");
    if (rent) terms.rent = rent;
    const deposit = amountOf("security_deposit", "deposit");
    if (deposit) terms.deposit = deposit;
  }
  return { prefill: { kind, names, terms, notes }, held };
}

/** Whether two readings of a form value are the same: the same figures when either has one, else the same words (one inside the other). */
function sameReading(a: string, b: string): boolean {
  const na = numbersIn(a);
  const nb = numbersIn(b);
  if (na.size || nb.size) return na.size === nb.size && [...na].every((n) => nb.has(n));
  const x = words(a);
  const y = words(b);
  return !!x && !!y && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
}
const words = (s: string) => normalize(s).replace(/\b(?:the|state|commonwealth|of)\b/g, " ").replace(/[^\p{L}]+/gu, " ").trim();

/**
 * The rules' pre-fill plus what Claude's analysis read, for the person to confirm. Claude's values come only from
 * groundDraft (each in its own quote, through Studio's checks) and are copied exactly. They never replace a rules value
 * and never fill a field the rules left empty because the document conflicts; where the two readings differ the field
 * is left empty and the page says why. The template's type is Claude's when it chose one, else the rules'.
 */
export function mergeAiPrefill(record: IntakeRecord, draft: DocDraft | null): Prefill {
  if (!draft) return draftPrefill(record);
  const sg = draft.suggestion;
  const rulesKind = KIND_OF[record.documentType.type] ?? null;
  const kind = sg.kind ?? rulesKind;
  if (!kind) return { ...draftPrefill(record), clarifications: sg.clarifications };
  const { prefill: base, held: heldList } = rulesPrefill(record, kind);
  const notes = [...base.notes];
  if (sg.kind && rulesKind && sg.kind !== rulesKind) notes.push(`The rules read this as a ${TEMPLATES[rulesKind].title} and Claude as a ${TEMPLATES[sg.kind].title}. Check the type of agreement.`);
  const held = new Set(heldList);
  const names = { ...base.names };
  const terms: Partial<Record<TermKey, string>> = { ...base.terms };
  const ai: NonNullable<Prefill["ai"]> = { names: {}, terms: {}, sources: draft.sources };
  for (const p of sg.parties) {
    const role = templateRoleOf(kind, p.role);
    if (!role || held.has(`role:${role}`) || ai.names[role]) continue;
    const rules = base.names[role];
    if (rules) {
      if (!sameReading(rules, p.name)) {
        delete names[role];
        notes.push(`${role}: the rules read “${rules}” and Claude read “${p.name}”, so it was left empty.`);
      }
      continue;
    }
    names[role] = p.name;
    ai.names[role] = p.name;
  }
  for (const [key, value] of Object.entries(sg.terms) as [TermKey, string][]) {
    if (!value || held.has(`term:${key}`)) continue;
    const rules = base.terms[key];
    if (rules) {
      if (!sameReading(rules, value)) {
        delete terms[key];
        notes.push(`${termName(key)}: the rules read “${rules}” and Claude read “${value}”, so it was left empty.`);
      }
      continue;
    }
    terms[key] = value;
    ai.terms[key] = value;
  }
  return { kind, names, terms, notes, ai, clarifications: sg.clarifications };
}

/** The latest AI analysis of a read document in this workspace (null when there is none). */
export function latestDocAnalysis(workspaceId: string, intakeId: string): { id: string; createdAt: string; createdBy: string; analysis: DocAnalysis } | null {
  const row = latestAnalysisRow(workspaceId, intakeId);
  return row ? { id: row.id, createdAt: row.created_at, createdBy: row.created_by, analysis: JSON.parse(row.result_json) as DocAnalysis } : null;
}

export function intakePrefill(s: SessionLike, id: string): { ok: true; prefill: Prefill; result: IntakeResult } | Failure {
  const r = getIntake(s, id);
  if (!r.ok) return r;
  if (r.result.record.routing.decision === "unsupported") return fail("invalid", "This document isn't a supported agreement, so there is nothing to start a draft from.");
  // with Claude's analysis, the values it read (checked against the document) are added for the person to confirm
  return { ok: true, prefill: mergeAiPrefill(r.result.record, latestDocAnalysis(s.workspaceId, r.result.id)?.analysis.draft ?? null), result: r.result };
}

/**
 * Start a Studio draft from a read document. The user must have confirmed the values; the draft is generated by the
 * Studio from exactly what they submitted. Recorded server-side as provenance (not a security boundary): who
 * confirmed, when, the draft, and which pre-filled fields were kept as read or changed.
 */
export async function startDraftFromIntake(s: SessionLike & { userEmail: string }, id: string, input: GenerateInput, confirmed: unknown) {
  if (confirmed !== true) return fail("invalid", "Confirm that you checked the values against the document first.");
  const p = intakePrefill(s, id);
  if (!p.ok) return p;
  const kept: string[] = [];
  const changed: string[] = [];
  if (p.prefill.kind && p.prefill.kind === input?.kind) {
    for (const [role, name] of Object.entries(p.prefill.names)) (input.parties?.find((x) => x?.role === role)?.name?.trim() === name ? kept : changed).push(`party:${role}`);
    for (const [key, value] of Object.entries(p.prefill.terms)) (String(input.terms?.[key as TermKey] ?? "").trim() === value ? kept : changed).push(`term:${key}`);
  } else changed.push(...Object.keys(p.prefill.names).map((r) => `party:${r}`), ...Object.keys(p.prefill.terms).map((k) => `term:${k}`));
  const r = await createDraft(s, input);
  if (!r.ok) return r;
  markDraftStarted(s.workspaceId, p.result.id, s.userId, r.draftId);
  try {
    recordEvent(s.workspaceId, "intake.draft_started", { intakeId: p.result.id, draftId: r.draftId, kind: input.kind, confirmedBy: s.userId, kept, changed }, `intake-draft:${p.result.id}:${r.draftId}`);
  } catch (e) {
    console.error("intake: workflow event not recorded", e instanceof Error ? e.message : e);
  }
  return r;
}

// ---------- workflow events (admins) ----------

export function workflowEvents(s: SessionLike): { ok: true; events: EventView[]; externalDelivery: false } | Failure {
  if (!isAdmin(s)) return fail("forbidden", "Only owners and admins can see workflow events.");
  syncStudioEvents(s.workspaceId);
  return { ok: true, events: listEvents(s.workspaceId), externalDelivery: false };
}
