import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { CLAUSE_KINDS, SOURCE_KINDS } from "@/lib/clauses";
import { CLAUSE_KIND_LABEL, SOURCE_KIND_LABEL, STATE_LABEL, STATE_TONE, capabilitiesOf, listClauses } from "@/lib/clauses/app/service";
import { createClauseAction } from "@/app/clauses-actions";
import { failureText } from "@/lib/clauses/app/messages";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Notice, PageHeader, Select, inputCls, timeAgo } from "@/components/ui";

export const metadata = { title: "Clause Library" };

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; issue?: string }> }) {
  const s = await requireSession();
  const q = await searchParams;
  const caps = capabilitiesOf(s);
  const list = listClauses(s);
  const clauses = list.ok ? list.value : [];
  return (
    <>
      <PageHeader
        title="Clause Library"
        sub="Your firm's standard clauses, with {{placeholders}} for the details that change. A clause is written as a draft, submitted, and approved by a different owner or admin; only approved text can be used in an agreement. Every version and decision is kept."
      />
      {q.error && <div className="mb-4"><Notice tone="error">{failureText(q.error, q.issue)}</Notice></div>}
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Clauses" description="Every clause in this workspace, newest version first." />
          {clauses.length === 0 ? (
            <EmptyState icon="agreement" title="No clauses yet" className="py-10">Write the first one with the form.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {clauses.map((c) => {
                const latest = c.versions[c.versions.length - 1];
                return (
                  <li key={c.id}>
                    <Link href={`/app/clauses/${encodeURIComponent(c.id)}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-subtle">
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium text-ink">{c.title}</span>
                        <span className="text-[12px] text-muted">{CLAUSE_KIND_LABEL[c.kind]} · v{latest.version} · {timeAgo(latest.provenance.createdAt)}</span>
                      </span>
                      <Badge tone={STATE_TONE[latest.state]}>{STATE_LABEL[latest.state]}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {caps.includes("edit") ? (
          <Card>
            <CardHeader title="New clause" description="It starts as a draft only you can edit." />
            <form action={createClauseAction} className="space-y-4 px-5 pb-5">
              <Field label="Title"><input name="title" required maxLength={200} className={inputCls} placeholder="Payment terms" /></Field>
              <Field label="Kind">
                <Select name="kind" defaultValue="general">
                  {CLAUSE_KINDS.map((k) => <option key={k} value={k}>{CLAUSE_KIND_LABEL[k]}</option>)}
                </Select>
              </Field>
              <Field label="Clause text" hint={<>Use {"{{name}}"} for a value filled in later. Types: {"{{fee:money}}"}, {"{{days:int}}"}, {"{{start:date}}"}, {"{{notes:multiline}}"}.</>}>
                <textarea name="body" required rows={7} maxLength={20000} className={inputCls} placeholder={"{{client.name}} shall pay {{fee:money}} within {{days:int}} days of the invoice date."} />
              </Field>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label="Source">
                  <Select name="sourceKind" defaultValue="firm_template">
                    {SOURCE_KINDS.map((k) => <option key={k} value={k}>{SOURCE_KIND_LABEL[k]}</option>)}
                  </Select>
                </Field>
                <Field label="Reference" hint="Optional, e.g. TPL-2026"><input name="sourceRef" maxLength={15} className={inputCls} pattern="[A-Za-z]{2,6}-[0-9]{1,8}" /></Field>
              </div>
              <Button type="submit" icon="plus">Create draft</Button>
            </form>
          </Card>
        ) : (
          <Card><div className="p-5 text-sm text-muted">You can read and use approved clauses. Writing clauses needs an editor role.</div></Card>
        )}
      </div>
    </>
  );
}
