// What the person asked for that a draft doesn't contain ("Claude understood, but this template can't include it"),
// kept with the draft so the reviewer and the approver see it on the draft itself, not only before Generate.
// Its own table, created if missing (no migration). Text from the form is untrusted: plain strings only, bounded,
// shown escaped; reads are scoped to the workspace.
import { db } from "../db";

export type Disclosure = { label: string; text: string };
const DDL = "CREATE TABLE IF NOT EXISTS draft_disclosures (draft_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, items_json TEXT NOT NULL, created_at TEXT NOT NULL)";
let ready = false;
const ensure = () => {
  if (!ready) { db().exec(DDL); ready = true; }
};
const MAX_ITEMS = 12;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The disclosure list as safe, bounded items (anything malformed is dropped). */
export function cleanDisclosures(items: unknown): Disclosure[] {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, MAX_ITEMS)
    .map((x) => ({ label: clean((x as Disclosure)?.label, 60), text: clean((x as Disclosure)?.text, 400) }))
    .filter((x) => x.text.length > 0);
}

/** Record them for a draft that was just created in this workspace (nothing when there are none). */
export function saveDisclosures(workspaceId: string, draftId: string, items: unknown): void {
  const list = cleanDisclosures(items);
  if (!list.length) return;
  ensure();
  db().prepare("INSERT OR REPLACE INTO draft_disclosures (draft_id, workspace_id, items_json, created_at) VALUES (?, ?, ?, ?)").run(draftId, workspaceId, JSON.stringify(list), new Date().toISOString());
}

/** A draft's disclosures, for its own workspace only. */
export function draftDisclosures(workspaceId: string, draftId: string): Disclosure[] {
  ensure();
  const row = db().prepare("SELECT items_json FROM draft_disclosures WHERE draft_id = ? AND workspace_id = ?").get(draftId, workspaceId) as { items_json: string } | undefined;
  if (!row) return [];
  try {
    return cleanDisclosures(JSON.parse(row.items_json));
  } catch {
    return [];
  }
}
