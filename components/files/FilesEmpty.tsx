import { EmptyState, LinkButton } from "@/components/ui";

// Two different situations: the workspace has no files at all, or a tab or search matched nothing.
export function FilesEmpty({ q, tabLabel, hasAny }: { q: string; tabLabel: string; hasAny: boolean }) {
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
