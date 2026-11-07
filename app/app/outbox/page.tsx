import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { emailMode } from "@/lib/email";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { EmailList } from "@/components/outbox/EmailList";
import { StatusFilter, filterHref } from "@/components/outbox/StatusFilter";
import { Pager } from "@/components/outbox/Pager";
import { DELIVERY, parseFilter } from "@/components/outbox/delivery";
import { emailPage, parsePage } from "@/components/outbox/query";

export const metadata = { title: "Email log" };

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string | string[]; page?: string | string[] }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const filter = parseFilter(one(sp.status));
  const { rows: shown, counts, total, page, pages, from, to } = emailPage(s.workspaceId, filter, parsePage(one(sp.page)));

  return (
    <>
      <PageHeader title="Email log" sub="Every email sent for your workspace: invitations, reminders, codes and signed copies, and whether each one was delivered." />
      {emailMode() === "outbox" && (
        <div className="mb-4">
          <Notice tone="warn">
            Email delivery isn&apos;t configured on this server (no provider key), so emails are recorded here instead of sent. Open one to see what the client would get.
          </Notice>
        </div>
      )}
      {counts.all === 0 ? (
        <Card>
          <EmptyState icon="mail" title="No emails yet">
            Invitations to sign, reminders, verification codes and signed copies appear here as soon as they go out.
          </EmptyState>
        </Card>
      ) : (
        <>
          <StatusFilter current={filter} counts={counts} />
          <Card className="overflow-hidden">
            {shown.length === 0 && filter !== "all" ? (
              <EmptyState icon="mail" title={`No emails ${filter === "logged" ? "logged only" : DELIVERY[filter].label.toLowerCase()}`}>
                {DELIVERY[filter].explain}{" "}
                <Link className="font-medium text-brand underline" href={filterHref("all")}>
                  Show all emails
                </Link>
              </EmptyState>
            ) : (
              <EmailList rows={shown} />
            )}
          </Card>
          {total > 0 && <Pager filter={filter} page={page} pages={pages} from={from} to={to} total={total} />}
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Personal signing links, codes and password links are withheld from the log, so nobody reading it can use them.
          </p>
        </>
      )}
    </>
  );
}
