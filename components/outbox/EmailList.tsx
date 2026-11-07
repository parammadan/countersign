import Link from "next/link";
import { fmtDateTime } from "@/lib/time";
import { DeliveryBadge } from "./DeliveryBadge";
import { deliveryOf, kindLabel, type LoggedEmail } from "./delivery";

/** One row per email: subject (the link), kind, recipient and time, delivery state, and the failure reason. */
export function EmailList({ rows }: { rows: LoggedEmail[] }) {
  return (
    <ul aria-label="Emails" className="divide-y divide-line">
      {rows.map((m) => (
        <li key={m.id} className="relative px-4 py-3.5 transition-colors hover:bg-subtle sm:px-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1">
              <Link href={`/app/outbox/${m.id}`} className="block text-sm font-medium text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 hover:text-brand sm:truncate">
                {m.subject}
              </Link>
              <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">
                <span className="font-medium text-ink-2">{kindLabel(m.kind)}</span> · to {m.to_email} · <time dateTime={m.created_at}>{fmtDateTime(m.created_at)}</time>
              </p>
              {deliveryOf(m.status) === "failed" && (
                <p className="mt-1 text-xs text-bad [overflow-wrap:anywhere]">Reason: {m.error || "the provider gave no reason"}</p>
              )}
            </div>
            <div className="shrink-0">
              <DeliveryBadge status={m.status} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
