"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cx, Logo } from "./ui";

const items = [
  { href: "/app", label: "Command center", exact: true },
  { href: "/app/files", label: "Files" },
  { href: "/app/agreements", label: "Agreements" },
  { href: "/app/outbox", label: "Email log" },
  { href: "/app/developers", label: "Integrations & API" },
  { href: "/app/settings", label: "Settings" },
];

export function Nav({ firm, user, logout }: { firm: string; user: string; logout: () => Promise<void> }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (h: string, exact?: boolean) => (exact ? path === h : path === h || path.startsWith(h + "/"));
  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/app"><Logo /></Link>
        <button onClick={() => setOpen((o) => !o)} className="rounded-md border border-line px-2.5 py-1.5 text-sm" aria-expanded={open}>
          Menu
        </button>
      </header>
      <aside
        className={cx(
          "z-20 flex-col border-r border-line bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0",
          open ? "fixed inset-x-0 top-[53px] bottom-0 flex" : "hidden",
        )}
      >
        <div className="hidden px-5 pt-5 pb-4 lg:block">
          <Link href="/app"><Logo /></Link>
        </div>
        <div className="px-5 pb-3 pt-4 lg:pt-0">
          <div className="truncate text-xs font-medium uppercase tracking-wide text-muted">{firm}</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {items.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              onClick={() => setOpen(false)}
              className={cx("block rounded-md px-2.5 py-2 text-sm", active(i.href, i.exact) ? "bg-brand/10 font-medium text-brand" : "text-ink hover:bg-gray-100")}
            >
              {i.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-line p-4">
          <Link href="/app/files/new" onClick={() => setOpen(false)} className="mb-3 flex w-full items-center justify-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
            + New file
          </Link>
          <div className="truncate text-xs text-muted">{user}</div>
          <form action={logout}>
            <button className="mt-1 text-xs font-medium text-muted hover:text-ink">Sign out</button>
          </form>
        </div>
      </aside>
    </>
  );
}
