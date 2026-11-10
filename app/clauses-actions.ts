"use server";

// Clause library actions. Every action takes the server session (never an id, role or workspace from the request) and
// goes through lib/clauses/app/service, which authorizes it from the session's role and scopes it to the workspace.
// Form fields are narrowed to strings of bounded length; the library validates everything else.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import * as svc from "@/lib/clauses/app/service";

const LIST = "/app/clauses";
const str = (fd: FormData, k: string, max: number) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.slice(0, max) : "";
};
const num = (fd: FormData, k: string) => {
  const v = str(fd, k, 6);
  return /^\d{1,5}$/.test(v) ? Number(v) : -1;
};
const clausePath = (id: string) => `${LIST}/${encodeURIComponent(id)}`;
const back = (to: string, r: { ok: true } | { ok: false; code: string; message: string }, ok: string): never => {
  if (r.ok) redirect(`${to}?ok=${ok}`);
  redirect(`${to}?error=${encodeURIComponent(r.code)}&msg=${encodeURIComponent(r.message.slice(0, 300))}`);
};

export async function createClauseAction(fd: FormData) {
  const s = await requireSession();
  const r = svc.createClause(s, {
    title: str(fd, "title", 300), kind: str(fd, "kind", 40), body: str(fd, "body", 20_000),
    source: svc.sourceFrom(str(fd, "sourceKind", 40), str(fd, "sourceRef", 40)),
  });
  if (r.ok) {
    revalidatePath(LIST);
    redirect(`${clausePath(r.value.id)}?ok=created`);
  }
  back(LIST, r, "created");
}

export async function addVersionAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const r = svc.addVersion(s, id, str(fd, "body", 20_000), svc.sourceFrom(str(fd, "sourceKind", 40), str(fd, "sourceRef", 40)));
  revalidatePath(clausePath(id));
  back(clausePath(id), r, "version");
}

export async function editDraftAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const r = svc.editDraft(s, id, num(fd, "n"), str(fd, "body", 20_000));
  revalidatePath(clausePath(id));
  back(clausePath(id), r, "saved");
}

export async function submitClauseAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const r = svc.submitVersion(s, id, num(fd, "n"));
  revalidatePath(clausePath(id));
  back(clausePath(id), r, "submitted");
}

export async function approveClauseAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const r = svc.approveVersion(s, id, num(fd, "n"));
  revalidatePath(clausePath(id));
  revalidatePath(LIST);
  back(clausePath(id), r, "approved");
}

export async function sendBackClauseAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const note = str(fd, "note", 500).trim();
  const r = svc.sendBackVersion(s, id, num(fd, "n"), note || undefined);
  revalidatePath(clausePath(id));
  back(clausePath(id), r, "sentback");
}

export async function retireClauseAction(fd: FormData) {
  const s = await requireSession();
  const id = str(fd, "id", 64);
  const note = str(fd, "note", 500).trim();
  const r = svc.retireVersion(s, id, num(fd, "n"), note || undefined);
  revalidatePath(clausePath(id));
  revalidatePath(LIST);
  back(clausePath(id), r, "retired");
}

/**
 * Agreement Studio's "insert from the library": renders the APPROVED, current version of a clause with the member's
 * values (lib/clauses useInDraft, so draft, in-review, retired and superseded text is refused). Returns the text; the
 * Studio then adds it through its own add-clause edit, which validates and versions it like any other edit.
 */
export async function renderApprovedClauseAction(clauseId: string, version: number, values: Record<string, string>) {
  const s = await requireSession();
  const id = typeof clauseId === "string" ? clauseId.slice(0, 64) : "";
  const n = typeof version === "number" && Number.isSafeInteger(version) ? version : -1;
  // fromEntries makes every key an own property ("__proto__" included), which the library refuses as unknown
  const params: Record<string, string> = Object.fromEntries(
    Object.entries(values && typeof values === "object" ? values : {}).slice(0, 40)
      .filter(([, v]) => typeof v === "string").map(([k, v]) => [k.slice(0, 200), (v as string).slice(0, 2_000)]),
  );
  const r = svc.useApproved(s, id, n, params);
  if (!r.ok) return { ok: false as const, message: r.message };
  const c = svc.getClause(s, id);
  return { ok: true as const, text: r.value, title: c.ok && c.value ? c.value.title : "" };
}
