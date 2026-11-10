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
import { analyzeDocument } from "./intake";
import { pagesFromExtraction } from "./pages";
import { getResult, insertResult, listResults, markDraftStarted, runsSince, type IntakeResult, type IntakeRow } from "./store";
import type { IntakeRecord } from "./types";
import { appOutbox, listEvents, recordEvent, syncStudioEvents, type EventView } from "../workflow/app";
import { runPipeline } from "../workflow/m4-pipeline";
import type { GenerateInput, Kind, TermKey } from "../m23/m23-generate/types";
import { createDraft } from "../drafts/service";

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

  const record = analyzeDocument({ pages, metadata: filename ? { filename } : undefined });
  const id = newId("int_");
  insertResult(s.workspaceId, { id, createdBy: s.userId, createdAt: new Date().toISOString(), source, filename, textSha256: sha256(pages.join("\f")), record });
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
};

const KIND_OF: Partial<Record<IntakeRecord["documentType"]["type"], Kind>> = { services: "services", nda: "nda", lease: "lease" };
const ROLES: Record<string, [string, string]> = { services: ["Provider", "Client"], nda: ["Disclosing Party", "Receiving Party"], lease: ["Landlord", "Tenant"] };
// intake role words (lower case) that name the same party as a Studio role
const ROLE_ALIAS: Record<string, string> = { provider: "Provider", "service provider": "Provider", consultant: "Provider", contractor: "Provider", client: "Client", customer: "Client", "disclosing party": "Disclosing Party", "receiving party": "Receiving Party", landlord: "Landlord", tenant: "Tenant" };

/**
 * The Studio form values an intake record supports, and nothing else: each value is copied from the record's
 * extracted values (never inferred), and a field with conflicting values is left empty. The user confirms every
 * value before anything is generated.
 */
export function draftPrefill(record: IntakeRecord): Prefill {
  const notes: string[] = [];
  const kind = KIND_OF[record.documentType.type] ?? null;
  if (!kind) return { kind: null, names: {}, terms: {}, notes: ["The document type has no Agreement Studio template, so choose one; no values were copied."] };
  const conflicted = new Set(record.conflicts.map((c) => c.field));
  const names: Record<string, string> = {};
  const roles = ROLES[kind];
  for (const role of roles) {
    const found = record.parties.filter((p) => p.value.role && ROLE_ALIAS[p.value.role.toLowerCase()] === role);
    const distinct = [...new Set(found.map((p) => p.value.name))];
    const inConflict = found.some((p) => conflicted.has(`parties.${p.value.role}`));
    if (distinct.length === 1 && !inConflict) names[role] = distinct[0];
    else if (distinct.length > 1 || inConflict) notes.push(`${role}: the document names more than one party for this role, so it was left empty.`);
  }
  const terms: Partial<Record<TermKey, string>> = {};
  const single = <T,>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);
  if (!conflicted.has("governingLaw")) {
    const law = single(record.governingLaw.map((g) => g.value));
    if (law) terms.governingLaw = law;
  } else notes.push("Governing law: the document gives more than one, so it was left empty.");
  const dateOf = (kinds: string[]) => {
    if (kinds.some((k) => conflicted.has(`dates.${k}`))) return undefined;
    return single([...new Set(record.dates.filter((d) => kinds.includes(d.value.kind)).map((d) => d.value.iso))]);
  };
  const start = dateOf(["effective", "start"]);
  if (start) terms.startDate = start;
  if (kind === "lease") {
    const end = dateOf(["end"]);
    if (end) terms.endDate = end;
  }
  const amountOf = (label: string) => {
    if (conflicted.has(`amounts.${label}`)) {
      notes.push(`${label}: the document gives more than one figure, so it was left empty.`);
      return undefined;
    }
    return single([...new Set(record.amounts.filter((a) => a.value.label === label).map((a) => a.value.raw.trim()))]);
  };
  if (kind === "services") {
    const fee = amountOf("fee");
    if (fee) terms.fee = fee;
  }
  if (kind === "lease") {
    const rent = amountOf("rent");
    if (rent) terms.rent = rent;
    const deposit = amountOf("security_deposit");
    if (deposit) terms.deposit = deposit;
  }
  return { kind, names, terms, notes };
}

export function intakePrefill(s: SessionLike, id: string): { ok: true; prefill: Prefill; result: IntakeResult } | Failure {
  const r = getIntake(s, id);
  if (!r.ok) return r;
  if (r.result.record.routing.decision === "unsupported") return fail("invalid", "This document isn't a supported agreement, so there is nothing to start a draft from.");
  return { ok: true, prefill: draftPrefill(r.result.record), result: r.result };
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
