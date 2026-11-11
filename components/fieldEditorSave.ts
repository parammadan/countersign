import type { Field } from "@/lib/fields";

/**
 * Save status once a PUT settles. If the field list changed while the request was in flight, the server
 * holds an older copy, so the editor is still dirty and must not claim "All changes saved".
 */
export function statusAfterSave(sent: Field[], latest: Field[], ok: boolean): "saved" | "dirty" | "error" {
  if (!ok) return "error";
  return sent === latest ? "saved" : "dirty";
}
