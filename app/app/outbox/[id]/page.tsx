import Link from "next/link";
import { notFound } from "next/navigation";
import { fmtDateTime } from "@/lib/time";
import { requireSession } from "@/lib/auth";
import { one } from "@/lib/db";
import { Card, Notice, PageHeader } from "@/components/ui";
import { DeliveryBadge } from "@/components/outbox/DeliveryBadge";
import { DELIVERY, deliveryOf, kindLabel, type LoggedEmail } from "@/components/outbox/delivery";
import { CLIENT_INVITE_KINDS, EMAIL_HELP } from "@/lib/email-guidance";

export const metadata = { title: "Email" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSession();
  const { id } = await params;
  const m = one<LoggedEmail & { html: string }>(
    "SELECT id, file_id, kind, to_email, subject, html, status, created_at, error FROM emails WHERE id = ? AND workspace_id = ?",
    id,
    s.workspaceId,
  );
  if (!m) notFound();
  const d = deliveryOf(m.status);

  return (
    <>
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb">
            <Link href="/app/outbox" className="hover:text-ink">Email log</Link>
            {m.file_id && (
              <>
                {" / "}
                <Link href={`/app/files/${m.file_id}`} className="hover:text-ink">Client file</Link>
              </>
            )}
          </nav>
        }
        title={m.subject}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="order-2 min-w-0 lg:order-1">
          <Card className="overflow-hidden">
            <iframe
              title="Email preview"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={m.html.replace("<head>", '<head><base target="_blank">').replace("<html>", '<html><head><base target="_blank"></head>')}
              className="block h-[560px] w-full bg-white sm:h-[640px]"
            />
          </Card>
        </div>

        <aside aria-label="Delivery" className="order-1 min-w-0 space-y-4 lg:order-2">
          <Card className="p-4 sm:p-5">
            <div className="mb-3">
              <DeliveryBadge status={m.status} />
            </div>
            <p className="text-sm leading-relaxed text-ink-2">{DELIVERY[d].explain}</p>
            <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
              <div>
                <dt className="text-xs font-medium text-muted">Type</dt>
                <dd className="mt-0.5 text-ink">{kindLabel(m.kind)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">To</dt>
                <dd className="mt-0.5 text-ink [overflow-wrap:anywhere]">{m.to_email}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Recorded</dt>
                <dd className="mt-0.5 text-ink">
                  <time dateTime={m.created_at}>{fmtDateTime(m.created_at)}</time>
                </dd>
              </div>
            </dl>
          </Card>
          {d === "delivered" && CLIENT_INVITE_KINDS.includes(m.kind) && <Notice tone="info">{EMAIL_HELP.client}</Notice>}
          {d === "failed" && (
            <Notice tone="error">
              <span className="font-medium">Not delivered.</span> <span className="[overflow-wrap:anywhere]">Reason: {m.error || "the provider gave no reason"}</span>
            </Notice>
          )}
          <Notice tone="info">
            This is the copy kept in the log. Personal signing links, codes and password links are withheld from it, so nobody reading the log can use them
            {d === "delivered" ? <>; the email the mail server accepted had the real link.</> : "."}
          </Notice>
        </aside>
      </div>
    </>
  );
}
