// The agreement library: every agreement in one workspace with its real state, version history and how many
// client files each version is pinned to. Read-only, tenant-scoped, three indexed queries whatever the size.
import { all } from "./db";

export type LibraryState = "live" | "draft" | "archived";

export type LibraryVersion = {
  id: string;
  version: number;
  status: "draft" | "published";
  /** the version new files use */
  live: boolean;
  sourceName: string;
  createdAt: string;
  publishedAt: string | null;
  /** client files pinned to this exact version */
  files: number;
};

export type LibraryAgreement = {
  id: string;
  name: string;
  isDefault: boolean;
  state: LibraryState;
  liveVersion: LibraryVersion | null;
  draft: LibraryVersion | null;
  /** newest first */
  versions: LibraryVersion[];
  files: number;
  createdAt: string;
};

export function agreementLibrary(wsId: string): LibraryAgreement[] {
  const tpls = all<{ id: string; name: string; is_default: number; archived: number; active_version_id: string | null; created_at: string }>(
    "SELECT id, name, is_default, archived, active_version_id, created_at FROM templates WHERE workspace_id = ? ORDER BY archived, is_default DESC, created_at DESC",
    wsId,
  );
  const vs = all<{ id: string; template_id: string; version: number; status: string; source_name: string; created_at: string; published_at: string | null }>(
    "SELECT id, template_id, version, status, source_name, created_at, published_at FROM template_versions WHERE workspace_id = ? ORDER BY version DESC",
    wsId,
  );
  const counts = new Map(
    all<{ v: string; n: number }>("SELECT template_version_id v, COUNT(*) n FROM files WHERE workspace_id = ? GROUP BY template_version_id", wsId).map((r) => [r.v, r.n]),
  );
  return tpls.map((t) => {
    const versions: LibraryVersion[] = vs
      .filter((v) => v.template_id === t.id)
      .map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status === "draft" ? "draft" : "published",
        live: v.id === t.active_version_id,
        sourceName: v.source_name,
        createdAt: v.created_at,
        publishedAt: v.published_at,
        files: counts.get(v.id) ?? 0,
      }));
    const liveVersion = versions.find((v) => v.live) ?? null;
    return {
      id: t.id,
      name: t.name,
      isDefault: !!t.is_default,
      state: t.archived ? "archived" : liveVersion ? "live" : "draft",
      liveVersion,
      draft: versions.find((v) => v.status === "draft") ?? null,
      versions,
      files: versions.reduce((n, v) => n + v.files, 0),
      createdAt: t.created_at,
    };
  });
}

export const LIBRARY_VIEWS = ["all", "live", "draft", "archived"] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/** Tab filter and name search. "All" leaves archived agreements out, like a mail archive. */
export function filterLibrary(items: LibraryAgreement[], view: LibraryView, q: string): LibraryAgreement[] {
  const needle = q.trim().toLowerCase();
  return items.filter(
    (a) =>
      (view === "all" ? a.state !== "archived" : view === "draft" ? a.state !== "archived" && !!a.draft : a.state === view) &&
      (!needle || a.name.toLowerCase().includes(needle) || a.versions.some((v) => v.sourceName.toLowerCase().includes(needle))),
  );
}

export function libraryCounts(items: LibraryAgreement[]): Record<LibraryView, number> {
  return {
    all: items.filter((a) => a.state !== "archived").length,
    live: items.filter((a) => a.state === "live").length,
    draft: items.filter((a) => a.state !== "archived" && !!a.draft).length,
    archived: items.filter((a) => a.state === "archived").length,
  };
}
