import Link from "next/link";
import { cx } from "@/components/ui";

export type FilesTab = { key: string; label: string; count: number };

// Status tabs for the files list. Links, not buttons, so the filter is in the URL and works without
// scripts. On a phone the row scrolls inside its own strip, never the page.
export function FilesTabs({ tabs, active, q }: { tabs: FilesTab[]; active: string; q: string }) {
  return (
    <nav aria-label="Filter files by status" className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <li key={t.key}>
              <Link
                href={`/app/files?status=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm whitespace-nowrap transition-colors",
                  on ? "border-brand bg-brand/10 font-medium text-brand" : "border-line bg-white text-muted hover:text-ink",
                )}
              >
                {t.label}
                <span className={cx("tabular text-xs", on ? "text-brand" : "text-muted")}>
                  {t.count}
                  <span className="sr-only"> {t.count === 1 ? "file" : "files"}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
