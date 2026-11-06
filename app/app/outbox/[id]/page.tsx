import Link from "next/link";
import { fmtDateTime } from "@/lib/time";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { one } from "@/lib/db";
import { Card } from "@/components/ui";

export const metadata = { title: "Email" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const m = one<{ subject: string; to_email: string; html: string; status: string; created_at: string; file_id: string | null }>(
    "SELECT subject, to_email, html, status, created_at, file_id FROM emails WHERE id = ? AND workspace_id = ?",
    id,
    s.workspaceId,
  );
  if (!m) notFound();
  return (
    <>
      <div className="mb-2 text-sm text-muted">
        <Link href="/app/outbox" className="hover:text-ink">Email log</Link>
        {m.file_id && <> / <Link href={`/app/files/${m.file_id}`} className="hover:text-ink">file</Link></>}
      </div>
      <h1 className="mb-1 text-xl font-semibold">{m.subject}</h1>
      <p className="mb-4 text-sm text-muted">To {m.to_email} · {fmtDateTime(m.created_at)} · {m.status}</p>
      <Card className="overflow-hidden">
        <iframe title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={m.html.replace("<head>", '<head><base target="_blank">').replace("<html>", '<html><head><base target="_blank"></head>')} className="h-[640px] w-full bg-white" />
      </Card>
    </>
  );
}
