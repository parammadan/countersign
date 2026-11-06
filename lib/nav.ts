import type { IconName } from "@/components/icons";

// Product navigation, in one place. Modules that exist today are `live`. Approved future modules are
// listed as `planned` so their place in the information architecture is decided, but `visibleNav()`
// never returns them: nothing unfinished is shown, linked or teased in the product.
//
// To ship a module: build its routes, then flip `status` to "live". Nothing else changes.

export type NavStatus = "live" | "planned";
export type NavSection = "work" | "intelligence" | "records" | "connect" | "admin";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  section: NavSection;
  status: NavStatus;
  /** match only the exact path (for the overview at /app) */
  exact?: boolean;
  /** hidden from staff, who can't open these pages anyway */
  adminOnly?: boolean;
}

export const SECTION_LABEL: Record<NavSection, string | null> = {
  work: null,
  intelligence: "Intelligence",
  records: "Records",
  connect: "Connect",
  admin: null,
};

export const NAV: NavItem[] = [
  { id: "overview", label: "Overview", href: "/app", icon: "overview", section: "work", status: "live", exact: true },
  { id: "files", label: "Client files", href: "/app/files", icon: "files", section: "work", status: "live" },
  { id: "agreements", label: "Agreements", href: "/app/agreements", icon: "agreement", section: "work", status: "live" },

  // Approved roadmap (M2+). Not rendered until built.
  { id: "studio", label: "Agreement Studio", href: "/app/studio", icon: "spark", section: "intelligence", status: "planned" },
  { id: "knowledge", label: "Knowledge Hub", href: "/app/knowledge", icon: "agreement", section: "intelligence", status: "planned" },
  { id: "documents", label: "Document Intelligence", href: "/app/documents", icon: "files", section: "intelligence", status: "planned" },
  { id: "inbox", label: "Smart Inbox", href: "/app/inbox", icon: "mail", section: "intelligence", status: "planned" },
  { id: "voice", label: "Voice", href: "/app/voice", icon: "send", section: "intelligence", status: "planned" },
  { id: "automations", label: "Automations", href: "/app/automations", icon: "spark", section: "intelligence", status: "planned" },

  { id: "emails", label: "Email log", href: "/app/outbox", icon: "mail", section: "records", status: "live" },
  { id: "developers", label: "Integrations & API", href: "/app/developers", icon: "code", section: "connect", status: "live", adminOnly: true },
  { id: "settings", label: "Settings", href: "/app/settings", icon: "settings", section: "admin", status: "live", adminOnly: true },
];

const ORDER: NavSection[] = ["work", "intelligence", "records", "connect", "admin"];

/** The navigation a given user should see: live modules only, admin pages only for admins. */
export function visibleNav(role: "owner" | "admin" | "staff"): { section: NavSection; label: string | null; items: NavItem[] }[] {
  const admin = role !== "staff";
  return ORDER.map((section) => ({
    section,
    label: SECTION_LABEL[section],
    items: NAV.filter((i) => i.section === section && i.status === "live" && (admin || !i.adminOnly)),
  })).filter((g) => g.items.length > 0);
}

export function isActive(path: string, item: Pick<NavItem, "href" | "exact">) {
  return item.exact ? path === item.href : path === item.href || path.startsWith(item.href + "/");
}
