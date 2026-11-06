import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { agreementLibrary, filterLibrary, libraryCounts, LIBRARY_VIEWS, type LibraryAgreement, type LibraryView } from "@/lib/library";
import { fmtDay } from "@/lib/time";
import { Badge, Button, Card, EmptyState, LinkButton, Notice, PageHeader, cx, inputCls } from "@/components/ui";
import { UploadAgreement } from "@/components/UploadAgreement";
import { UploadPanelButton } from "@/components/UploadPanelButton";
import { TemplateMenu } from "@/components/TemplateMenu";
import { newDraftAction, testFileAction } from "@/app/actions";

export const metadata = { title: "Agreements" };

const VIEW_LABEL: Record<LibraryView, string> = { all: "All", live: "Live", draft: "Drafts", archived: "Archived" };

export default async function Page({ searchParams }: { searchParams: Promise<{ published?: string; error?: string; view?: string; q?: string }> }) {
  const s = await requireSession();
  const sp = await searchParams;
  const admin = s.role !== "staff";
  const view: LibraryView = (LIBRARY_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as LibraryView) : "all";
  const q = (sp.q ?? "").trim().slice(0, 100);
  const library = agreementLibrary(s.workspaceId);
  const counts = libraryCounts(library);
  const shown = filterLibrary(library, view, q);
  const href = (v: LibraryView, query = q) => `/app/agreements?${new URLSearchParams({ ...(v !== "all" && { view: v }), ...(query && { q: query }) })}`;

  return (
    <>
      <PageHeader
        title="Agreements"
        sub={
          admin
            ? "The agreement every client signs. Upload it once, check the fields, publish, and every new file sends that exact version."
            : "The agreements your firm sends. Only admins can upload, edit or publish them."
        }
        actions={admin && library.length > 0 ? <UploadPanelButton target="upload" /> : undefined}
      />
      {sp.error && <div className="mb-4"><Notice tone="error">{sp.error.slice(0, 300)}</Notice></div>}
      {sp.published && (
        <div className="mb-4">
          <Notice tone="ok">
            Published. New files now use this version; files already sent stay on the version they were sent with.{" "}
            <Link className="font-medium underline" href="/app/files/new">Open a file</Link>
          </Notice>
        </div>
      )}

      {library.length === 0 ? (
        admin ? (
          <Card className="p-5 sm:p-6">
            <h2 className="text-[15px] font-semibold">Upload your client agreement</h2>
            <p className="mt-1 mb-4 text-sm text-muted">Use the PDF or Word file you already send. Nothing goes to a client until you have checked the fields and published.</p>
            <UploadAgreement />
          </Card>
        ) : (
          <Card>
            <EmptyState icon="agreement" title="No agreements yet">An admin in your workspace uploads and publishes the firm&apos;s agreement. Then you can open files with it.</EmptyState>
          </Card>
        )
      ) : (
        <>
          {admin && (
            <details id="upload" className="group mb-5 scroll-mt-4 rounded-[var(--radius-lg)] border border-line bg-panel shadow-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <span>Upload a new agreement <span className="font-normal text-muted">(for example, another service line)</span></span>
                <span className="text-muted transition-transform group-open:rotate-45" aria-hidden>+</span>
              </summary>
              <div className="border-t border-line p-5">
                <UploadAgreement />
                <p className="mt-3 text-xs text-muted">To replace an existing agreement, use <b>Upload new version</b> on its card instead, so its history stays together.</p>
              </div>
            </details>
          )}

          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <nav aria-label="Filter agreements" className="flex flex-wrap gap-1.5">
              {LIBRARY_VIEWS.map((v) => (
                <Link
                  key={v}
                  href={href(v)}
                  aria-current={v === view ? "page" : undefined}
                  className={cx("rounded-full border px-3 py-1 text-sm", v === view ? "border-brand bg-brand/10 font-medium text-brand" : "border-line bg-white text-muted hover:text-ink")}
                >
                  {VIEW_LABEL[v]} <span className="tabular">{counts[v]}</span>
                </Link>
              ))}
            </nav>
            <form className="flex gap-2 lg:w-80" role="search">
              {view !== "all" && <input type="hidden" name="view" value={view} />}
              <input name="q" defaultValue={q} placeholder="Search by name or file name" aria-label="Search agreements" className={inputCls} />
            </form>
          </div>

          {shown.length === 0 ? (
            <Card>
              <EmptyState icon="agreement" title={q ? `No agreements match “${q}”` : view === "archived" ? "Nothing archived" : view === "draft" ? "No drafts waiting" : "No live agreements"}>
                {q ? <Link className="font-medium text-brand underline" href={href(view, "")}>Clear the search</Link> : view === "archived" ? "Archived agreements appear here and can be restored." : view === "draft" ? "Uploads and edits wait here until they are published." : "Publish an agreement to start sending it."}
              </EmptyState>
            </Card>
          ) : (
            <ul className="space-y-4" aria-label="Agreements">
              {shown.map((a) => (
                <li key={a.id}>
                  <AgreementCard a={a} admin={admin} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function StateBadge({ a }: { a: LibraryAgreement }) {
  if (a.state === "archived") return <Badge>Archived</Badge>;
  if (a.state === "draft") return <Badge tone="warn" icon="pen">Draft, not published</Badge>;
  return <Badge tone="ok" icon="checkCircle">Live: version {a.liveVersion!.version}</Badge>;
}

function AgreementCard({ a, admin }: { a: LibraryAgreement; admin: boolean }) {
  const live = a.liveVersion;
  const usable = a.state === "live";
  const meta =
    a.state === "archived"
      ? `Archived. ${a.files} client file${a.files === 1 ? "" : "s"} keep${a.files === 1 ? "s" : ""} the version they were signed with.`
      : live
        ? `Version ${live.version} published ${live.publishedAt ? fmtDay(live.publishedAt) : ""} · ${a.files} client file${a.files === 1 ? "" : "s"} in total`
        : `Uploaded ${fmtDay(a.versions[a.versions.length - 1].createdAt)}. Check the fields and publish to start sending it.`;
  return (
    <Card>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold break-words">{a.name}</h2>
            <StateBadge a={a} />
            {a.isDefault && <Badge tone="brand">Default</Badge>}
            {usable && a.draft && <Badge tone="warn">Draft v{a.draft.version} in review</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{meta}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {a.draft && a.state !== "archived" && (
            <LinkButton href={`/app/agreements/${a.draft.id}`} variant={admin ? "primary" : "secondary"} icon="pen">
              {admin ? `Review draft v${a.draft.version}` : `View draft v${a.draft.version}`}
            </LinkButton>
          )}
          {usable && (
            <LinkButton href={`/app/files/new?template=${a.id}`} variant={a.draft && admin ? "secondary" : "primary"} icon="plus">
              Use for a new file
            </LinkButton>
          )}
          {usable && admin && !a.draft && (
            <form action={newDraftAction}>
              <input type="hidden" name="versionId" value={live!.id} />
              <Button variant="secondary" icon="pen">Edit fields</Button>
            </form>
          )}
        </div>
      </div>

      <details className="group border-t border-line" open={a.versions.length <= 3}>
        <summary className="cursor-pointer list-none px-5 py-2.5 text-xs font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>›</span> Version history · {a.versions.length} version{a.versions.length === 1 ? "" : "s"}
        </summary>
        <ul className="divide-y divide-line border-t border-line" aria-label={`Versions of ${a.name}`}>
          {a.versions.map((v) => (
            <li key={v.id} className="relative flex flex-col gap-1 px-5 py-2.5 text-sm hover:bg-subtle sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Link href={`/app/agreements/${v.id}`} className="shrink-0 font-medium text-ink after:absolute after:inset-0 hover:text-brand">
                  Version {v.version}
                </Link>
                <span className="min-w-0 truncate text-muted">{v.sourceName}</span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{v.status === "draft" ? `Uploaded ${fmtDay(v.createdAt)}` : `Published ${v.publishedAt ? fmtDay(v.publishedAt) : ""}`}</span>
                <span className="tabular">{v.files} client file{v.files === 1 ? "" : "s"}</span>
                {v.live ? <Badge tone="ok">Live</Badge> : v.status === "draft" ? <Badge tone="warn">Draft</Badge> : <Badge>Previous</Badge>}
              </div>
            </li>
          ))}
        </ul>
      </details>

      {admin && (
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          {a.state !== "archived" ? <UploadAgreement templateId={a.id} compact /> : <span className="text-xs text-muted">Restore it to send it or upload a new version.</span>}
          <div className="flex flex-wrap items-center gap-1.5">
            {usable && (
              <form action={testFileAction}>
                <input type="hidden" name="templateId" value={a.id} />
                <Button size="sm" variant="ghost" icon="send" title="Opens a file with you as the client, so you can see exactly what clients see">
                  Send a test to me
                </Button>
              </form>
            )}
            <TemplateMenu templateId={a.id} name={a.name} isDefault={a.isDefault} archived={a.state === "archived"} />
          </div>
        </div>
      )}
    </Card>
  );
}
