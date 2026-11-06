"use client";

import { useActionState, useState } from "react";
import { templateAction, type FormState } from "@/app/actions";
import { Button, inputCls } from "./ui";

/** Rename, make default, archive and restore. Each is a real server action, scoped to the workspace on the server. */
export function TemplateMenu({ templateId, name, isDefault, archived }: { templateId: string; name: string; isDefault: boolean; archived: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(templateAction, undefined);
  const [renaming, setRenaming] = useState(false);
  return (
    <form action={act} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="templateId" value={templateId} />
      {renaming ? (
        <>
          <input name="name" defaultValue={name} aria-label="Agreement name" maxLength={120} className={inputCls + " h-8 w-56 py-1 text-sm"} autoFocus />
          <Button name="op" value="rename" size="sm" variant="secondary" disabled={pending} onClick={() => setTimeout(() => setRenaming(false), 50)}>
            Save name
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(true)}>
          Rename
        </Button>
      )}
      {!isDefault && !archived && (
        <Button name="op" value="default" size="sm" variant="ghost" disabled={pending}>
          Make default
        </Button>
      )}
      {archived ? (
        <Button name="op" value="restore" size="sm" variant="secondary" disabled={pending}>
          Restore
        </Button>
      ) : (
        <Button
          name="op"
          value="archive"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={(e) => !confirm(`Archive “${name}”? It stops being offered for new files. Files already sent and signed are unaffected, and you can restore it from Archived.`) && e.preventDefault()}
        >
          Archive
        </Button>
      )}
      <span aria-live="polite" className="text-xs">
        {st?.error && <span className="text-bad">{st.error}</span>}
        {st?.ok && <span className="text-ok">{st.ok}</span>}
      </span>
    </form>
  );
}
