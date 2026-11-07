import Link from "next/link";
import type { DeliveryFilter } from "./delivery";

/** Link to one page of the log, keeping the filter. */
export function pageHref(f: DeliveryFilter, page: number) {
  const q = new URLSearchParams();
  if (f !== "all") q.set("status", f);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/app/outbox?${s}` : "/app/outbox";
}

const linkCls = "rounded-md border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:bg-subtle";

/** Previous/Next as plain links, so paging works without JavaScript. */
export function Pager({ filter, page, pages, from, to, total }: { filter: DeliveryFilter; page: number; pages: number; from: number; to: number; total: number }) {
  return (
    <nav aria-label="Email log pages" className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted tabular">
        Showing {from}–{to} of {total}
      </p>
      {pages > 1 && (
        <div className="flex gap-2">
          {page > 1 && (
            <Link className={linkCls} href={pageHref(filter, page - 1)} rel="prev">
              Previous
            </Link>
          )}
          {page < pages && (
            <Link className={linkCls} href={pageHref(filter, page + 1)} rel="next">
              Next
            </Link>
          )}
        </div>
      )}
    </nav>
  );
}
