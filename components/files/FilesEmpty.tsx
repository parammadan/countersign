import { EmptyState, LinkButton } from "@/components/ui";

// Two different situations: the workspace has no files at all, or a tab or search matched nothing.
/** `canOpen`: a published agreement exists, so a new file can send it. Before that, the one action is publishing one. */
export function FilesEmpty({ q, tabLabel, hasAny, canOpen = true, admin = true }: { q: string; tabLabel: string; hasAny: boolean; canOpen?: boolean; admin?: boolean }) {
  if (!hasAny && !canOpen) {
    return (
      <EmptyState
        title="No files yet"
        icon="agreement"
        action={admin ? <LinkButton href="/app/agreements" icon="upload">Upload agreement</LinkButton> : undefined}
      >
        {admin
          ? "A file is one job or case for one client, and it sends your published agreement. Upload the PDF or Word agreement you already use and publish it first."
          : "A file is one job or case for one client, and it sends your firm's published agreement. An admin publishes it first."}
      </EmptyState>
    );
  }
  if (!hasAny) {
    return (
      <EmptyState
        title="No files yet"
        action={<LinkButton href="/app/files/new" icon="plus">New file</LinkButton>}
      >
        A file is one job or case for one client. Open the first one and the agreement goes out on its own.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon="files"
      title={q ? "No files match that search" : "Nothing in this view"}
      action={<LinkButton href="/app/files?status=all" variant="secondary">Show all files</LinkButton>}
    >
      {q ? <>Nothing in “{tabLabel}” matches “{q}”. Check the spelling or try a shorter search.</> : <>No files are in “{tabLabel}” right now.</>}
    </EmptyState>
  );
}
