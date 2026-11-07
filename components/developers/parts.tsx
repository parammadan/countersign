import type { ReactNode } from "react";
import { Badge, Card, CardHeader, EmptyState, cx } from "@/components/ui";
import type { IconName } from "@/components/icons";

export function Section({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 overflow-hidden">
      <CardHeader title={<span id={`${id}-h`}>{title}</span>} description={description} />
      <div className="space-y-5 p-4 sm:p-5">{children}</div>
    </Card>
  );
}

export function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre tabIndex={0} aria-label={label} className="overflow-x-auto rounded-lg bg-[#0f1729] p-4 text-[12.5px] leading-relaxed text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong">
      <EmptyState icon={icon} title={title} className="py-8">{children}</EmptyState>
    </div>
  );
}

export function Row({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <li className={cx("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3", muted && "bg-subtle text-muted")}>{children}</li>;
}

export function List({ label, children }: { label: string; children: ReactNode }) {
  return <ul aria-label={label} className="divide-y divide-line rounded-lg border border-line text-sm">{children}</ul>;
}

export function StatusPill({ status, code }: { status: string; code: number | null }) {
  const tone = status === "delivered" ? "ok" : status === "dead" ? "bad" : "warn";
  return <Badge tone={tone}>{status}{code ? ` (${code})` : ""}</Badge>;
}
