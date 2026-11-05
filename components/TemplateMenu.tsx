"use client";

import { useActionState, useState } from "react";
import { templateAction, type FormState } from "@/app/actions";
import { Button, inputCls } from "./ui";

export function TemplateMenu({ templateId, name, isDefault }: { templateId: string; name: string; isDefault: boolean }) {
  const [st, act, pending] = useActionState<FormState, FormData>(templateAction, undefined);
  const [renaming, setRenaming] = useState(false);
  return (
    <form action={act} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="templateId" value={templateId} />
      {renaming ? (
        <>
          <input name="name" defaultValue={name} className={inputCls + " w-48"} autoFocus />
          <Button name="op" value="rename" variant="secondary" disabled={pending} onClick={() => setTimeout(() => setRenaming(false), 50)}>Save</Button>
        </>
      ) : (
        <Button type="button" variant="ghost" onClick={() => setRenaming(true)}>Rename</Button>
      )}
      {!isDefault && <Button name="op" value="default" variant="ghost" disabled={pending}>Make default</Button>}
      <Button name="op" value="archive" variant="ghost" disabled={pending} onClick={(e) => !confirm("Archive this agreement? Existing files keep their signed copies.") && e.preventDefault()}>Archive</Button>
      {st?.error && <span className="text-xs text-bad">{st.error}</span>}
    </form>
  );
}
