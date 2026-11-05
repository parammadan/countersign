"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PdfPages, pct } from "./PdfPages";
import { Button, Notice, cx, inputCls } from "./ui";
import { BUILTIN_PREFILL, FIELD_TYPES, ROLE_LABEL, ROLES, TYPE_LABEL, validateForPublish, type Field, type FieldType, type PageSize, type Role } from "@/lib/fields";

const ROLE_STYLE: Record<Role, { box: string; chip: string; solid: string }> = {
  client: { box: "border-blue-500 bg-blue-500/15", chip: "bg-blue-50 text-blue-700", solid: "bg-blue-500" },
  firm: { box: "border-violet-500 bg-violet-500/15", chip: "bg-violet-50 text-violet-700", solid: "bg-violet-500" },
  prefill: { box: "border-amber-500 bg-amber-400/20", chip: "bg-amber-50 text-amber-800", solid: "bg-amber-500" },
};

const PRESETS: { label: string; type: FieldType; role: Role; w: number; h: number; prefillKey?: string }[] = [
  { label: "Client signature", type: "signature", role: "client", w: 180, h: 30 },
  { label: "Client initials", type: "initials", role: "client", w: 60, h: 22 },
  { label: "Client name", type: "name", role: "client", w: 170, h: 15 },
  { label: "Date signed", type: "date", role: "client", w: 110, h: 15 },
  { label: "Client text", type: "text", role: "client", w: 170, h: 15 },
  { label: "Checkbox", type: "checkbox", role: "client", w: 12, h: 12 },
  { label: "Firm signature", type: "signature", role: "firm", w: 180, h: 30 },
  { label: "Blank from file data", type: "text", role: "prefill", w: 150, h: 15, prefillKey: "custom.blank" },
];

type Detection = { warnings: string[]; textLayer: boolean; addedSignaturePage: boolean; ms: number; proposed: number; defined?: { firm: string[]; client: string[] } };

export function FieldEditor({
  versionId,
  pdfUrl,
  pages,
  initial,
  detection,
  readOnly,
  firmName,
}: {
  versionId: string;
  pdfUrl: string;
  pages: PageSize[];
  initial: Field[];
  detection: Detection;
  readOnly: boolean;
  firmName: string;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<Field[]>(initial);
  const [sel, setSel] = useState<string | null>(null);
  const [placing, setPlacing] = useState<(typeof PRESETS)[number] | null>(null);
  const [saved, setSaved] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [err, setErr] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; f: Field; scale: number } | null>(null);
  const first = useRef(true);

  const selected = fields.find((f) => f.id === sel) ?? null;
  const problems = useMemo(() => validateForPublish(fields, pages), [fields, pages]);

  const save = useCallback(
    async (fs: Field[]) => {
      setSaved("saving");
      const r = await fetch(`/api/versions/${versionId}/fields`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: fs }) });
      if (!r.ok) {
        setSaved("error");
        setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save");
        return false;
      }
      setSaved("saved");
      setErr(null);
      return true;
    },
    [versionId],
  );

  useEffect(() => {
    if (readOnly) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setSaved("dirty");
    const t = setTimeout(() => save(fields), 700);
    return () => clearTimeout(t);
  }, [fields, readOnly, save]);

  const update = (id: string, patch: Partial<Field>) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch, confidence: 1, reason: f.reason } : f)));
  const remove = (id: string) => {
    setFields((fs) => fs.filter((f) => f.id !== id));
    setSel(null);
  };
  const nextId = () => {
    let n = fields.length + 1;
    while (fields.some((f) => f.id === `f${n}`)) n++;
    return `f${n}`;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / d.scale;
      const dy = (e.clientY - d.sy) / d.scale;
      const p = pages[d.f.page];
      if (d.mode === "move") {
        update(d.id, { x: clamp(d.f.x + dx, 0, p.width - d.f.w), y: clamp(d.f.y + dy, 0, p.height - d.f.h) });
      } else {
        update(d.id, { w: clamp(d.f.w + dx, 8, p.width - d.f.x), h: clamp(d.f.h + dy, 8, p.height - d.f.y) });
      }
    };
    const up = () => (drag.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  useEffect(() => {
    if (readOnly) return;
    const key = (e: KeyboardEvent) => {
      if (!sel || (e.target as HTMLElement).closest("input,select,textarea")) return;
      const f = fields.find((x) => x.id === sel);
      if (!f) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "Delete" || e.key === "Backspace") remove(sel);
      else if (e.key === "ArrowLeft") update(sel, { x: f.x - step });
      else if (e.key === "ArrowRight") update(sel, { x: f.x + step });
      else if (e.key === "ArrowUp") update(sel, { y: f.y - step });
      else if (e.key === "ArrowDown") update(sel, { y: f.y + step });
      else if (e.key === "Escape") setSel(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function publish() {
    setPublishing(true);
    setErr(null);
    if (!(await save(fields))) {
      setPublishing(false);
      return;
    }
    const r = await fetch(`/api/versions/${versionId}/publish`, { method: "POST" });
    setPublishing(false);
    if (!r.ok) {
      setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't publish");
      return;
    }
    router.push("/app/agreements?published=1");
    router.refresh();
  }

  const counts = ROLES.map((r) => ({ r, n: fields.filter((f) => f.role === r).length }));
  const lowConf = fields.filter((f) => (f.confidence ?? 1) < 0.6).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        {placing && (
          <div className="sticky top-14 z-20 mb-3 lg:top-2">
            <Notice tone="info">
              Click on the page where the <b>{placing.label.toLowerCase()}</b> goes.{" "}
              <button className="font-medium underline" onClick={() => setPlacing(null)}>Cancel</button>
            </Notice>
          </div>
        )}
        <div className="rounded-xl bg-gray-200/70 p-2 sm:p-4">
          <PdfPages
            url={pdfUrl}
            pages={pages}
            onPageClick={(page, x, y) => {
              if (readOnly) return;
              if (!placing) {
                setSel(null);
                return;
              }
              const p = pages[page];
              const id = nextId();
              let prefillKey = placing.prefillKey;
              if (prefillKey === "custom.blank") {
                let k = "custom.blank";
                let i = 1;
                while (fields.some((f) => f.prefillKey === k)) k = `custom.blank_${++i}`;
                prefillKey = k;
              }
              const f: Field = {
                id,
                type: placing.type,
                role: placing.role,
                page,
                x: clamp(x - placing.w / 2, 0, p.width - placing.w),
                y: clamp(y - placing.h / 2, 0, p.height - placing.h),
                w: placing.w,
                h: placing.h,
                label: placing.role === "prefill" ? "Blank" : TYPE_LABEL[placing.type],
                required: placing.role === "client" && placing.type !== "checkbox" && placing.type !== "text",
                prefillKey,
                confidence: 1,
                reason: "added by hand",
              };
              setFields((fs) => [...fs, f]);
              setSel(id);
              setPlacing(null);
            }}
            overlay={(page, scale) =>
              fields
                .filter((f) => f.page === page)
                .map((f) => {
                  const p = pages[page];
                  const low = (f.confidence ?? 1) < 0.6;
                  return (
                    <div
                      key={f.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${ROLE_LABEL[f.role]}: ${f.label}`}
                      onPointerDown={(e) => {
                        if (readOnly) return;
                        e.stopPropagation();
                        e.preventDefault();
                        setSel(f.id);
                        drag.current = { id: f.id, mode: "move", sx: e.clientX, sy: e.clientY, f, scale };
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(f.id);
                      }}
                      className={cx(
                        "group absolute flex items-center overflow-hidden rounded-[3px] border text-[10px] leading-none font-medium select-none",
                        ROLE_STYLE[f.role].box,
                        !readOnly && "cursor-move",
                        sel === f.id && "ring-2 ring-offset-1 ring-ink/70",
                        low && "border-dashed",
                      )}
                      style={{ left: pct(f.x, p.width), top: pct(f.y, p.height), width: pct(f.w, p.width), height: pct(f.h, p.height) }}
                    >
                      <span className={cx("truncate px-1", f.type === "signature" ? "text-[11px]" : "")} style={{ fontSize: Math.max(8, Math.min(11, f.h * scale * 0.5)) }}>
                        {f.type === "checkbox" ? "" : f.role === "prefill" ? `⟨${f.label}⟩` : f.label}
                      </span>
                      {low && <span className="absolute -top-0.5 right-0.5 text-[9px] text-amber-700">?</span>}
                      {!readOnly && (
                        <span
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setSel(f.id);
                            drag.current = { id: f.id, mode: "resize", sx: e.clientX, sy: e.clientY, f, scale };
                          }}
                          className={cx("absolute right-0 bottom-0 h-2.5 w-2.5 cursor-se-resize", ROLE_STYLE[f.role].solid, sel === f.id ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
                        />
                      )}
                    </div>
                  );
                })
            }
          />
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{readOnly ? "Fields" : "Review fields"}</h2>
            {!readOnly && (
              <span className={cx("text-xs", saved === "error" ? "text-bad" : "text-muted")}>
                {saved === "saving" ? "Saving…" : saved === "dirty" ? "Unsaved" : saved === "error" ? "Not saved" : "All changes saved"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            {detection.proposed} found automatically in {Math.max(1, Math.round(detection.ms / 100) / 10)}s.
            {firmName && ` Blocks under “${firmName}” are treated as your firm's.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {counts.map(({ r, n }) => (
              <span key={r} className={cx("rounded-full px-2 py-0.5 text-xs font-medium", ROLE_STYLE[r].chip)}>
                {n} {ROLE_LABEL[r].toLowerCase()}
              </span>
            ))}
          </div>
          {(detection.warnings.length > 0 || lowConf > 0) && (
            <ul className="mt-3 space-y-1.5 text-xs text-amber-900">
              {detection.warnings.map((w, i) => (
                <li key={i} className="rounded-md bg-amber-50 px-2 py-1.5">{w}</li>
              ))}
            </ul>
          )}
          {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
          {!readOnly && (
            <div className="mt-4 space-y-2">
              {problems.length > 0 && (
                <ul className="space-y-1 text-xs text-bad">
                  {problems.slice(0, 3).map((p, i) => <li key={i}>• {p}</li>)}
                </ul>
              )}
              <Button className="w-full" onClick={publish} disabled={publishing || problems.length > 0}>
                {publishing ? "Publishing…" : "Looks right: publish"}
              </Button>
              <p className="text-[11px] text-muted">Publishing locks this version. Every new file uses it until you publish another.</p>
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="rounded-xl border border-line bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Add a field</h3>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setPlacing(p)}
                  className={cx("rounded-md border px-2 py-1.5 text-left text-xs hover:bg-gray-50", placing?.label === p.label ? "border-brand bg-brand/5" : "border-line")}
                >
                  <span className={cx("mr-1.5 inline-block h-2 w-2 rounded-full", ROLE_STYLE[p.role].solid)} />
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {selected && (
          <div className="rounded-xl border border-line bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Selected field</h3>
              {!readOnly && <button className="text-xs font-medium text-bad" onClick={() => remove(selected.id)}>Delete</button>}
            </div>
            <fieldset disabled={readOnly} className="space-y-3 text-sm">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Who fills it</span>
                <select className={inputCls} value={selected.role} onChange={(e) => {
                  const role = e.target.value as Role;
                  update(selected.id, { role, prefillKey: role === "prefill" ? selected.prefillKey ?? "client.name" : undefined, required: role === "client" ? selected.required : false });
                }}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Type</span>
                <select className={inputCls} value={selected.type} onChange={(e) => update(selected.id, { type: e.target.value as FieldType })}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Label</span>
                <input className={inputCls} value={selected.label} maxLength={120} onChange={(e) => update(selected.id, { label: e.target.value })} />
              </label>
              {selected.role === "prefill" && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Filled from</span>
                  <select
                    className={inputCls}
                    value={selected.prefillKey?.startsWith("custom.") ? "custom" : selected.prefillKey}
                    onChange={(e) => update(selected.id, { prefillKey: e.target.value === "custom" ? `custom.${slug(selected.label)}` : e.target.value })}
                  >
                    {Object.entries(BUILTIN_PREFILL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    <option value="custom">Asked when the file is created</option>
                  </select>
                  {selected.prefillKey?.startsWith("custom.") && <span className="mt-1 block text-[11px] text-muted">Staff fill “{selected.label}” on the new-file form (or send it as prefill.{selected.prefillKey.slice(7)} in the API).</span>}
                </label>
              )}
              {selected.role === "client" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.required} onChange={(e) => update(selected.id, { required: e.target.checked })} /> Required
                </label>
              )}
              {selected.reason && (
                <p className="rounded-md bg-gray-50 px-2 py-1.5 text-[11px] text-muted">
                  Why: {selected.reason}
                  {selected.confidence !== undefined && selected.confidence < 1 ? ` (confidence ${Math.round(selected.confidence * 100)}%)` : ""}
                </p>
              )}
              {!readOnly && <p className="text-[11px] text-muted">Drag to move, corner to resize, arrow keys to nudge, Delete to remove.</p>}
            </fieldset>
          </div>
        )}

        <div className="rounded-xl border border-line bg-white p-4 text-xs text-muted">
          <div className="mb-2 font-medium text-ink">Legend</div>
          <ul className="space-y-1">
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-blue-500" />Client signs or fills it in</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-violet-500" />Your firm: filled and signed automatically</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />Filled from the file (client name, fee, date…)</li>
            <li>Dashed border = low confidence, please check</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}
