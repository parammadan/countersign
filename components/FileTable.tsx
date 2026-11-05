import Link from "next/link";
import type { FileRow } from "@/lib/types";
import { StatusBadge, timeAgo } from "./ui";

export function FileTable({ files, empty }: { files: (FileRow & { agreement?: string })[]; empty: React.ReactNode }) {
  if (!files.length) return <div className="px-5 py-10 text-center text-sm text-muted">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-5 py-2.5">File</th>
            <th className="px-3 py-2.5">Client</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Sent</th>
            <th className="px-5 py-2.5 text-right">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id} className="border-b border-line last:border-0 hover:bg-gray-50">
              <td className="px-5 py-3">
                <Link href={`/app/files/${f.id}`} className="font-medium text-ink hover:text-brand">
                  {f.title}
                </Link>
                <div className="text-xs text-muted">{f.ref ? `Ref ${f.ref}` : f.agreement ?? ""}</div>
              </td>
              <td className="px-3 py-3">
                <div>{f.client_name}</div>
                <div className="text-xs text-muted">{f.client_email}</div>
              </td>
              <td className="px-3 py-3"><StatusBadge status={f.status} /></td>
              <td className="px-3 py-3 text-muted tabular">{timeAgo(f.sent_at)}</td>
              <td className="px-5 py-3 text-right text-muted tabular">
                {timeAgo(f.completed_at || f.declined_at || f.voided_at || f.client_signed_at || f.viewed_at || f.sent_at || f.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
