import type { DraftDocument } from "./types";

export type Version = {
  readonly id: string;
  readonly number: number;
  readonly doc: DraftDocument;
  readonly author: string;
  readonly at: string;
  readonly note: string;
  readonly kind: "edit" | "rollback";
  readonly restoredFrom?: string;
};
export type VersionHistory = { readonly versions: readonly Version[] };

export const emptyHistory: VersionHistory = Object.freeze({ versions: Object.freeze([]) as readonly Version[] });

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export type CommitMeta = { author: string; at: string; note?: string };

/** Version ids are `v<n>` and unique only within one history; hosts that store several histories must scope them by document id.
 * Append an immutable snapshot (deep-copied and frozen). Returns a new history; the old one is untouched. */
export function commitVersion(h: VersionHistory, doc: DraftDocument, meta: CommitMeta, kind: "edit" | "rollback" = "edit", restoredFrom?: string): VersionHistory {
  const number = h.versions.length + 1;
  const v: Version = deepFreeze({
    id: `v${number}`,
    number,
    doc: structuredClone(doc),
    author: meta.author,
    at: meta.at,
    note: meta.note ?? "",
    kind,
    ...(restoredFrom ? { restoredFrom } : {}),
  });
  return Object.freeze({ versions: Object.freeze([...h.versions, v]) });
}

export const getVersion = (h: VersionHistory, id: string) => h.versions.find((v) => v.id === id);
export const latestVersion = (h: VersionHistory) => h.versions[h.versions.length - 1];

/** Roll back by creating a NEW version whose content is a copy of the target. Nothing earlier is changed or removed. */
export function rollbackTo(h: VersionHistory, id: string, meta: CommitMeta): VersionHistory {
  const target = getVersion(h, id);
  if (!target) throw new Error(`unknown version ${id}`);
  return commitVersion(
    h,
    { ...structuredClone(target.doc), origin: { kind: "edit", versionId: target.id } },
    { ...meta, note: meta.note ?? `Rolled back to ${target.id}` },
    "rollback",
    target.id,
  );
}
