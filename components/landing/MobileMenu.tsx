"use client";
// The landing header's menu on phones and small tablets (hidden from md up, where the links sit in the header).
// A disclosure button: Escape or picking a link closes it, and focus goes back to the button on Escape.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { cx } from "@/components/ui";

export type MenuItem = { href: string; label: string; primary?: boolean };

export function MobileMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="md:hidden">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls="landing-menu"
        onClick={() => setOpen((o) => !o)}
        className="ml-1 grid h-9 w-9 place-items-center rounded-lg border border-line-strong bg-white text-ink shadow-1"
      >
        <Icon name={open ? "x" : "menu"} size={18} />
        <span className="sr-only">{open ? "Close menu" : "Menu"}</span>
      </button>
      <div id="landing-menu" hidden={!open} className="absolute inset-x-0 top-full border-b border-line bg-white px-4 pt-2 pb-4 shadow-2">
        <ul className="mx-auto max-w-6xl">
          {items.map((it) => (
            <li key={it.href}>
              <a
                href={it.href}
                onClick={() => setOpen(false)}
                className={cx(
                  "mt-1 flex h-11 items-center justify-between rounded-lg px-3 text-[15px] font-medium",
                  it.primary ? "mt-3 justify-center bg-brand text-white" : "text-ink hover:bg-subtle",
                )}
              >
                {it.label}
                {!it.primary && <Icon name="chevronRight" size={16} className="text-faint" />}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
