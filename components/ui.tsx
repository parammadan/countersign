import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { STATUS_LABEL, type FileStatus } from "@/lib/types";
import { BRAND } from "@/lib/brand";
import { Icon, type IconName } from "./icons";

// Shared UI primitives. Every export keeps its original props, so existing screens keep working; new
// options (size, loading, icons) are additive.

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const btn = {
  primary: "bg-brand text-white shadow-1 hover:brightness-110 active:brightness-95",
  secondary: "bg-white text-ink border border-line-strong shadow-1 hover:bg-subtle hover:border-[#c2c8d2] active:bg-bg",
  ghost: "text-ink-2 hover:bg-black/[.045] hover:text-ink active:bg-black/[.07]",
  danger: "bg-white text-bad border border-[#f3c3be] shadow-1 hover:bg-bad-bg active:bg-[#fde4e1]",
};
const size = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-[7px]",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-[10px]",
};
const btnBase =
  "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none transition-[background-color,border-color,filter,box-shadow,color] duration-150 ease-out-soft disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}

export function Button({
  variant = "primary",
  size: s = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...p
}: ComponentProps<"button"> & { variant?: keyof typeof btn; size?: keyof typeof size; loading?: boolean; icon?: IconName }) {
  return (
    <button {...p} disabled={disabled || loading} aria-busy={loading || undefined} className={cx(btnBase, size[s], btn[variant], className)}>
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={s === "sm" ? 15 : 16} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "primary",
  size: s = "md",
  icon,
  className,
  children,
  ...p
}: ComponentProps<typeof Link> & { variant?: keyof typeof btn; size?: keyof typeof size; icon?: IconName }) {
  return (
    <Link {...p} className={cx(btnBase, size[s], btn[variant], className)}>
      {icon && <Icon name={icon} size={s === "sm" ? 15 : 16} />}
      {children}
    </Link>
  );
}

export function Card({ className, children, ...p }: ComponentProps<"div">) {
  return (
    <div {...p} className={cx("rounded-[var(--radius-lg)] border border-line bg-panel shadow-1", className)}>
      {children}
    </div>
  );
}

/** Card title row: heading, optional description and a right-aligned action. */
export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-start justify-between gap-4 border-b border-line px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "block w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm text-ink shadow-1 transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-[#c2c8d2] focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/15 disabled:bg-subtle disabled:text-muted aria-invalid:border-bad aria-invalid:ring-bad/15";

export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Select(p: ComponentProps<"select">) {
  return <select {...p} className={cx(inputCls, "pr-8", p.className)} />;
}

// ---------- status ----------

const tone: Record<FileStatus, { cls: string; icon: IconName }> = {
  draft: { cls: "bg-gray-100 text-gray-700 ring-gray-200", icon: "pen" },
  sent: { cls: "bg-blue-50 text-blue-800 ring-blue-200/70", icon: "send" },
  viewed: { cls: "bg-indigo-50 text-indigo-800 ring-indigo-200/70", icon: "clock" },
  signed: { cls: "bg-amber-50 text-amber-900 ring-amber-200/80", icon: "pen" },
  completed: { cls: "bg-emerald-50 text-emerald-800 ring-emerald-200/80", icon: "checkCircle" },
  declined: { cls: "bg-red-50 text-red-800 ring-red-200/80", icon: "error" },
  voided: { cls: "bg-gray-100 text-gray-600 ring-gray-200", icon: "x" },
  expired: { cls: "bg-orange-50 text-orange-800 ring-orange-200/80", icon: "clock" },
};

/** File status: icon + text, so it never relies on colour alone. */
export function StatusBadge({ status }: { status: FileStatus }) {
  const t = tone[status];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", t.cls)}>
      <Icon name={t.icon} size={12} className="shrink-0" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const badgeTone = {
  neutral: "bg-gray-100 text-gray-700 ring-gray-200",
  brand: "bg-brand-soft text-brand ring-brand/20",
  ok: "bg-ok-bg text-ok ring-emerald-200/80",
  warn: "bg-warn-bg text-warn ring-amber-200/80",
  bad: "bg-bad-bg text-bad ring-red-200/80",
};
export function Badge({ tone: t = "neutral", icon, children, className }: { tone?: keyof typeof badgeTone; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", badgeTone[t], className)}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

// ---------- page structure ----------

export function PageHeader({ title, sub, actions, eyebrow }: { title: string; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[13px] text-muted">{eyebrow}</div>}
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {sub && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const noticeTone = {
  info: { cls: "border-blue-200/80 bg-blue-50/70 text-blue-950", icon: "info" as const, ic: "text-blue-600" },
  warn: { cls: "border-amber-200 bg-warn-bg text-amber-950", icon: "alert" as const, ic: "text-amber-600" },
  error: { cls: "border-red-200 bg-bad-bg text-red-900", icon: "error" as const, ic: "text-red-600" },
  ok: { cls: "border-emerald-200 bg-ok-bg text-emerald-950", icon: "checkCircle" as const, ic: "text-emerald-600" },
};
export function Notice({ tone: t = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const c = noticeTone[t];
  return (
    <div role={t === "error" ? "alert" : undefined} className={cx("flex gap-2.5 rounded-[var(--radius)] border px-3.5 py-3 text-sm leading-relaxed", c.cls)}>
      <Icon name={c.icon} size={17} className={cx("mt-[1px] shrink-0", c.ic)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A real empty state: says what is missing and offers the one action that fixes it. */
export function EmptyState({ icon = "files", title, children, action, className }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-12 text-center", className)}>
      <span className="mb-3 grid h-10 w-10 place-items-center rounded-full bg-brand-soft text-brand">
        <Icon name={icon} size={19} />
      </span>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("cs-skeleton rounded-md", className)} />;
}

/** A number with a label. Pass href to make the whole tile a link to the filtered list. */
export function Stat({ label, value, hint, href, tone: t }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "ok" | "warn" | "bad" }) {
  const body = (
    <>
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={cx("mt-1.5 text-[26px] leading-none font-semibold tracking-tight tabular", t === "ok" ? "text-ok" : t === "warn" ? "text-warn" : t === "bad" ? "text-bad" : "text-ink")}>{value}</div>
      {hint && <div className="mt-2 text-xs text-muted">{hint}</div>}
    </>
  );
  const cls = "block rounded-[var(--radius-lg)] border border-line bg-panel p-4 shadow-1";
  return href ? (
    <Link href={href} className={cx(cls, "transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-2")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-subtle px-1 py-px font-mono text-[11px] text-ink-2">{children}</kbd>;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span aria-hidden className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white", className)}>
      {initials || "?"}
    </span>
  );
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

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6.5" fill="var(--brand)" />
      <path d="M6 15.5c1.6-3.6 3.2-5.4 4.4-5.4 1.7 0 .2 5.6 1.9 5.6 1.2 0 2-2.4 3.3-2.4.9 0 1 1.6 2.4 1.6" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      <path d="M6 18.3h12" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink", className)}>
      <LogoMark />
      {BRAND.name}
    </span>
  );
}
