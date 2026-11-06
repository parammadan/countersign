"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { NavItem, NavSection } from "@/lib/nav";
import { isActive } from "@/lib/nav";
import { Icon } from "./icons";
import { Avatar, cx, Logo } from "./ui";

type Group = { section: NavSection; label: string | null; items: NavItem[] };
type Props = { firm: string; role: string; user: string; userName: string; groups: Group[]; logout: () => Promise<void> };

const ROLE_TEXT: Record<string, string> = { owner: "Owner", admin: "Admin", staff: "Staff" };

export function Nav(p: Props) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  // phone menu: Escape closes it, the page behind it doesn't scroll, focus goes in and comes back
  useEffect(() => {
    if (!open) return;
    const back = trigger.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      back?.focus();
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-white/85 px-4 backdrop-blur-md lg:hidden">
        <Link href="/app" className="rounded-md">
          <Logo />
        </Link>
        <button
          ref={trigger}
          onClick={() => setOpen(true)}
          className="grid h-10 w-10 place-items-center rounded-lg text-ink-2 hover:bg-black/5"
          aria-expanded={open}
          aria-controls="app-nav"
          aria-label="Open menu"
        >
          <Icon name="menu" size={20} />
        </button>
      </header>

      {open && <div aria-hidden className="cs-fade-in fixed inset-0 z-40 bg-ink/30 backdrop-blur-[1px] lg:hidden" onClick={() => setOpen(false)} />}

      <aside
        id="app-nav"
        aria-label="Main"
        className={cx(
          "z-50 w-[272px] shrink-0 flex-col border-r border-line bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64",
          open ? "cs-slide-in fixed inset-y-0 left-0 flex shadow-3" : "hidden",
        )}
      >
        <div className="flex h-14 items-center justify-between px-4 lg:h-16 lg:px-5">
          <Link href="/app" onClick={() => setOpen(false)} className="rounded-md">
            <Logo />
          </Link>
          <button ref={closeBtn} onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-black/5 lg:hidden" aria-label="Close menu">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-[var(--radius)] border border-line bg-subtle px-2.5 py-2">
          <Avatar name={p.firm} className="h-8 w-8 rounded-lg text-xs" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{p.firm}</div>
            <div className="text-[11px] text-muted">{ROLE_TEXT[p.role] ?? p.role} · workspace</div>
          </div>
        </div>

        <div className="px-3 pb-2">
          <Link href="/app/files/new" onClick={() => setOpen(false)} className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-sm font-medium text-white shadow-1 transition hover:brightness-110">
            <Icon name="plus" size={16} />
            New file
          </Link>
        </div>

        <nav aria-label="Workspace" className="flex-1 overflow-y-auto px-3 pt-2 pb-4">
          {p.groups.map((g) => (
            <div key={g.section} className="mt-3 first:mt-0">
              {g.label && <div className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{g.label}</div>}
              <ul className="space-y-0.5">
                {g.items.map((i) => {
                  const on = isActive(path, i);
                  return (
                    <li key={i.id}>
                      <Link
                        href={i.href}
                        onClick={() => setOpen(false)}
                        aria-current={on ? "page" : undefined}
                        className={cx(
                          "group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                          on ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-black/[.04] hover:text-ink",
                        )}
                      >
                        <Icon name={i.icon} size={17} className={on ? "text-brand" : "text-faint group-hover:text-muted"} />
                        {i.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 px-1">
            <Avatar name={p.userName || p.user} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{p.userName || p.user}</div>
              <div className="truncate text-[11px] text-muted">{p.user}</div>
            </div>
          </div>
          <form action={p.logout} className="mt-2">
            <button className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] font-medium text-muted transition-colors hover:bg-black/[.04] hover:text-ink">
              <Icon name="logout" size={16} />
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
