import Link from "next/link";
import { cx } from "@/components/ui";
import { DELIVERIES, DELIVERY, type DeliveryFilter } from "./delivery";

export const filterHref = (f: DeliveryFilter) => (f === "all" ? "/app/outbox" : `/app/outbox?status=${f}`);

/** Filter chips: plain links, so filtering works without JavaScript and each view has its own URL. */
export function StatusFilter({ current, counts }: { current: DeliveryFilter; counts: Record<DeliveryFilter, number> }) {
  const items: { f: DeliveryFilter; label: string }[] = [{ f: "all", label: "All" }, ...DELIVERIES.map((f) => ({ f, label: DELIVERY[f].filter }))];
  return (
    <nav aria-label="Filter by delivery status" className="mb-4 flex flex-wrap gap-1.5">
      {items.map(({ f, label }) => (
        <Link
          key={f}
          href={filterHref(f)}
          aria-current={f === current ? "page" : undefined}
          className={cx("rounded-full border px-3 py-1 text-sm", f === current ? "border-brand bg-brand/10 font-medium text-brand" : "border-line bg-white text-muted hover:text-ink")}
        >
          {label} <span className="tabular">{counts[f]}</span>
        </Link>
      ))}
    </nav>
  );
}
