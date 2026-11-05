import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { all } from "@/lib/db";
import { emailMode } from "@/lib/email";
import { Card, Notice, PageHeader, cx } from "@/components/ui";

export const metadata = { title: "Email log" };

export default async function Page() {
  const s = await requireSession();
  const rows = all<{ id: string; file_id: string | null; kind: string; to_email: string; subject: string; status: string; created_at: string; error: string | null }>(
    "SELECT id, file_id, kind, to_email, subject, status, created_at, error FROM emails WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200",
    s.workspaceId,
  );
  return (
    <>
      <PageHeader title="Email log" sub="Every email sent for your workspace: invitations, reminders, codes and signed copies." />
      {emailMode() === "outbox" && (
        <div className="mb-4">
          <Notice tone="warn">Email delivery isn&apos;t configured on this server (no provider key), so emails are recorded here instead of sent. Open one to see exactly what the client would get, including the signing link.</Notice>
        </div>
      )}
      <Card>
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">No emails yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <Link href={`/app/outbox/${m.id}`} className="block truncate font-medium hover:text-brand">{m.subject}</Link>
                  <div className="truncate text-xs text-muted">to {m.to_email} · {new Date(m.created_at).toLocaleString()}{m.error ? ` · ${m.error}` : ""}</div>
                </div>
                <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs", m.status === "sent" ? "bg-emerald-50 text-emerald-700" : m.status === "failed" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600")}>{m.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
