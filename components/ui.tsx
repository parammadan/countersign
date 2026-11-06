import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { STATUS_LABEL, type FileStatus } from "@/lib/types";
import { BRAND } from "@/lib/brand";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const btn = {
  primary: "bg-brand text-white hover:brightness-110 shadow-sm",
  secondary: "bg-white text-ink border border-line hover:bg-gray-50 shadow-sm",
  ghost: "text-ink hover:bg-black/5",
  danger: "bg-white text-bad border border-red-200 hover:bg-red-50",
};

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: keyof typeof btn }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        btn[variant],
        className,
      )}
    />
  );
}

export function LinkButton({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: keyof typeof btn }) {
  return (
    <Link
      {...p}
      className={cx("inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition", btn[variant], className)}
    />
  );
}

export function Card({ className, children, ...p }: ComponentProps<"div">) {
  return (
    <div {...p} className={cx("rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(16,24,40,.04)]", className)}>
      {children}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "block w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";

export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Select(p: ComponentProps<"select">) {
  return <select {...p} className={cx(inputCls, "pr-8", p.className)} />;
}

const tone: Record<FileStatus, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-50 text-blue-700",
  viewed: "bg-indigo-50 text-indigo-700",
  signed: "bg-amber-50 text-amber-800",
  completed: "bg-emerald-50 text-emerald-700",
  declined: "bg-red-50 text-red-700",
  voided: "bg-gray-100 text-gray-500 line-through",
  expired: "bg-orange-50 text-orange-700",
};

export function StatusBadge({ status }: { status: FileStatus }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tone[status])}>{STATUS_LABEL[status]}</span>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Notice({ tone: t = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const c = { info: "border-blue-200 bg-blue-50 text-blue-900", warn: "border-amber-200 bg-amber-50 text-amber-900", error: "border-red-200 bg-red-50 text-red-800", ok: "border-emerald-200 bg-emerald-50 text-emerald-900" }[t];
  return <div className={cx("rounded-lg border px-3.5 py-2.5 text-sm", c)}>{children}</div>;
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: process.env.APP_TZ || "America/New_York" });
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
        <rect width="24" height="24" rx="6" fill="var(--brand)" />
        <path d="M6 15.5c1.6-3.6 3.2-5.4 4.4-5.4 1.7 0 .2 5.6 1.9 5.6 1.2 0 2-2.4 3.3-2.4.9 0 1 1.6 2.4 1.6" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" />
        <path d="M6 18.3h12" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {BRAND.name}
    </span>
  );
}
