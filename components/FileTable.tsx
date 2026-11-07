import { Fragment, isValidElement } from "react";
import Link from "next/link";
import type { FileRow } from "@/lib/types";
import { StatusBadge, timeAgo } from "./ui";

// The file list. One markup for every screen size: a five-column row from lg (1024px) up, a stacked card on a phone
// (no sideways scrolling). The whole row is clickable through the title link, which is what a screen
// reader announces.
type Row = Pick<FileRow, "id" | "title" | "ref" | "client_name" | "client_email" | "status" | "sent_at" | "completed_at" | "declined_at" | "voided_at" | "client_signed_at" | "viewed_at" | "created_at"> & {
  agreement?: string;
};

const cols = "lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_9.5rem_5.5rem_6.5rem] lg:items-center lg:gap-4";

export function FileTable({ files, empty }: { files: Row[]; empty: React.ReactNode }) {
  if (!files.length) {
    // A plain message (text or a fragment, like the overview's) gets the padded wrapper; a component such as
    // an EmptyState brings its own spacing, so it renders bare.
    if (isValidElement(empty) && empty.type !== Fragment) return empty;
    return <div className="px-5 py-10 text-center text-sm text-muted">{empty}</div>;
  }
  return (
    <div>
      <div aria-hidden className={`hidden border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase ${cols}`}>
        <span>File</span>
        <span>Client</span>
        <span>Status</span>
        <span>Sent</span>
        <span className="text-right">Last activity</span>
      </div>
      <ul className="divide-y divide-line text-sm">
        {files.map((f) => {
          const last = f.completed_at || f.declined_at || f.voided_at || f.client_signed_at || f.viewed_at || f.sent_at || f.created_at;
          return (
            <li key={f.id} className={`relative px-5 py-3.5 transition-colors hover:bg-subtle ${cols}`}>
              <div className="min-w-0">
                <Link href={`/app/files/${f.id}`} className="block truncate font-medium text-ink after:absolute after:inset-0 hover:text-brand focus-visible:after:rounded-[inherit]">
                  {f.title}
                </Link>
                <div className="mt-0.5 truncate text-xs text-muted">{f.ref ? `Ref ${f.ref}` : f.agreement ?? ""}</div>
              </div>
              <div className="mt-2 min-w-0 lg:mt-0">
                <div className="truncate text-sm text-ink-2">{f.client_name}</div>
                <div className="truncate text-xs text-muted">{f.client_email}</div>
              </div>
              <div className="mt-2.5 flex items-center justify-between gap-3 lg:contents">
                <div className="lg:mt-0">
                  <StatusBadge status={f.status} />
                </div>
                <div className="hidden text-sm text-muted tabular lg:block">{timeAgo(f.sent_at)}</div>
                <div className="text-xs text-muted tabular lg:text-right lg:text-sm">
                  <span className="lg:hidden">Updated </span>
                  {timeAgo(last)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
