"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PdfPages, pct } from "./PdfPages";
import { Modal } from "./SignaturePad";
import { Button, Notice, cx, inputCls } from "./ui";
import {
  BUILTIN_PREFILL,
  FIELD_TYPES,
  ROLE_LABEL,
  ROLES,
  TYPE_LABEL,
  clampToPage,
  overlappingFields,
  validateForPublish,
  type Field,
  type FieldType,
  type PageSize,
  type Role,
} from "@/lib/fields";

const ROLE_STYLE: Record<Role, { box: string; chip: string; solid: string }> = {
  client: { box: "border-blue-500 bg-blue-500/15", chip: "bg-blue-50 text-blue-700", solid: "bg-blue-500" },
  firm: { box: "border-violet-500 bg-violet-500/15", chip: "bg-violet-50 text-violet-700", solid: "bg-violet-500" },
  prefill: { box: "border-amber-500 bg-amber-400/20", chip: "bg-amber-50 text-amber-800", solid: "bg-amber-500" },
};

const ROLE_HELP: Record<Role, string> = {
  client: "The client completes this in the signing room.",
  firm: "Completed automatically with your firm's adopted countersignature, name, title or date.",
  prefill: "Filled in from the file when it's sent, such as the client's name or a reference.",
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

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LOW = 0.6;

type Detection = { warnings: string[]; textLayer: boolean; addedSignaturePage: boolean; ms: number; proposed: number; defined?: { firm: string[]; client: string[] } };

export function FieldEditor({
  versionId,
  pdfUrl,
  pages,
  initial,
  detection,
  readOnly,
  firmName,
  templateName = "this agreement",
  versionNumber = 1,
  live = null,
}: {
  versionId: string;
  pdfUrl: string;
  pages: PageSize[];
  initial: Field[];
  detection: Detection;
  readOnly: boolean;
  firmName: string;
  templateName?: string;
  versionNumber?: number;
  /** the version new files use today, if any, and how many client files are pinned to it */
  live?: { version: number; files: number } | null;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<Field[]>(initial);
  const [sel, setSel] = useState<string | null>(null);
  const [placing, setPlacing] = useState<(typeof PRESETS)[number] | null>(null);
  const [saved, setSaved] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [err, setErr] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(0);
  const [placePage, setPlacePage] = useState(0);
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; f: Field; scale: number; moved: boolean } | null>(null);

  // Undo: snapshots of the whole field list. A snapshot that equals the current list (a click, a focus with
  // no edit) is skipped, so Undo only lights up after a real change.
  const history = useRef<Field[][]>([]);
  const current = useRef(fields);
  const [canUndo, setCanUndo] = useState(false);
  useEffect(() => {
    current.current = fields;
    setCanUndo(history.current.some((h) => h !== fields));
  }, [fields]);
  const snapshot = useCallback(() => {
    const fs = current.current;
    if (history.current[history.current.length - 1] !== fs) history.current.push(fs);
    if (history.current.length > 100) history.current.shift();
  }, []);
  const undo = useCallback(() => {
    let prev = history.current.pop();
    while (prev && prev === current.current) prev = history.current.pop();
    if (prev) setFields(prev);
  }, []);

  const first = useRef(true);
  const publishingRef = useRef(false);
  const selected = fields.find((f) => f.id === sel) ?? null;
  const problems = useMemo(() => validateForPublish(fields, pages), [fields, pages]);
  const overlaps = useMemo(() => overlappingFields(fields), [fields]);
  const overlapIds = useMemo(() => new Set(overlaps.flat().map((f) => f.id)), [overlaps]);
  const lowConf = fields.filter((f) => (f.confidence ?? 1) < LOW).length;

  const save = useCallback(
    async (fs: Field[]) => {
      setSaved("saving");
      try {
        const r = await fetch(`/api/versions/${versionId}/fields`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: fs }) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save");
      } catch (e) {
        setSaved("error");
        setErr(e instanceof TypeError ? "Couldn't reach the server, so your last change isn't saved." : (e as Error).message);
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
    const t = setTimeout(() => {
      if (!publishingRef.current) save(fields);
    }, 700);
    return () => clearTimeout(t);
  }, [fields, readOnly, save]);

  // leaving with a change that hasn't reached the server asks first
  useEffect(() => {
    if (readOnly || saved === "saved") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved, readOnly]);

  /** Any change to where a field sits is kept on its page. */
  const update = useCallback(
    (id: string, patch: Partial<Field>) =>
      setFields((fs) =>
        fs.map((f) => {
          if (f.id !== id) return f;
          const next = { ...f, ...patch, confidence: 1, reason: f.reason };
          return "x" in patch || "y" in patch || "w" in patch || "h" in patch ? clampToPage(next, pages[next.page]) : next;
        }),
      ),
    [pages],
  );
  const remove = (id: string) => {
    snapshot();
    setFields((fs) => fs.filter((f) => f.id !== id));
    setSel(null);
  };
  const nextId = () => {
    let n = fields.length + 1;
    while (fields.some((f) => f.id === `f${n}`)) n++;
    return `f${n}`;
  };

  function place(preset: (typeof PRESETS)[number], pageIndex: number, cx: number, cy: number) {
    const p = pages[pageIndex];
    const id = nextId();
    let prefillKey = preset.prefillKey;
    if (prefillKey === "custom.blank") {
      let k = "custom.blank";
      let i = 1;
      while (fields.some((f) => f.prefillKey === k)) k = `custom.blank_${++i}`;
      prefillKey = k;
    }
    const f: Field = clampToPage(
      {
        id,
        type: preset.type,
        role: preset.role,
        page: pageIndex,
        x: cx - preset.w / 2,
        y: cy - preset.h / 2,
        w: preset.w,
        h: preset.h,
        label: preset.role === "prefill" ? "Blank" : TYPE_LABEL[preset.type],
        required: preset.role === "client" && preset.type !== "checkbox" && preset.type !== "text",
        prefillKey,
        confidence: 1,
        reason: "added by hand",
      },
      p,
    );
    snapshot();
    setFields((fs) => [...fs, f]);
    setSel(id);
    setPlacing(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field-id="${id}"]`)?.focus({ preventScroll: true }));
  }

  function showField(id: string) {
    setSel(id);
    const el = document.querySelector<HTMLElement>(`[data-field-id="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    el?.focus({ preventScroll: true });
  }

  // while a page jump scrolls smoothly, the pages it passes don't change the indicator
  const jumping = useRef(0);
  const onCurrentPage = useCallback((p: number) => {
    if (Date.now() > jumping.current) setPage(p);
  }, []);
  function goToPage(i: number) {
    const n = Math.max(0, Math.min(pages.length - 1, i));
    jumping.current = Date.now() + 900;
    setPage(n);
    document.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / d.scale;
      const dy = (e.clientY - d.sy) / d.scale;
      if (!d.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
        snapshot();
        d.moved = true;
      }
      const p = pages[d.f.page];
      if (d.mode === "move") update(d.id, { x: d.f.x + dx, y: d.f.y + dy });
      else update(d.id, { w: Math.min(Math.max(d.f.w + dx, 8), p.width - d.f.x), h: Math.min(Math.max(d.f.h + dy, 8), p.height - d.f.y) });
    };
    const up = () => (drag.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [pages, snapshot, update]);

  useEffect(() => {
    if (readOnly) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,select,textarea,[role=dialog]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === "Escape") {
        if (placing) setPlacing(null);
        else setSel(null);
        return;
      }
      if (!sel || t.closest("button:not([data-field-id]),a")) return;
      const f = fields.find((x) => x.id === sel);
      if (!f) return;
      const p = pages[f.page];
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === "Delete" || e.key === "Backspace") remove(sel);
      else if (arrows[e.key]) {
        const [dx, dy] = arrows[e.key];
        snapshot();
        // Alt + arrows resizes from the bottom-right corner; plain arrows move
        if (e.altKey) update(sel, { w: Math.min(Math.max(f.w + dx, 8), p.width - f.x), h: Math.min(Math.max(f.h + dy, 8), p.height - f.y) });
        else update(sel, { x: f.x + dx, y: f.y + dy });
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function publish() {
    publishingRef.current = true;
    setPublishing(true);
    setErr(null);
    if (!(await save(fields))) {
      publishingRef.current = false;
      setPublishing(false);
      setConfirming(false);
      return;
    }
    const r = await fetch(`/api/versions/${versionId}/publish`, { method: "POST" }).catch(() => null);
    if (!r || !r.ok) {
      publishingRef.current = false;
      setPublishing(false);
      setConfirming(false);
      setErr(r ? (((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't publish") : "Couldn't reach the server. Nothing was published.");
      return;
    }
    router.push("/app/agreements?published=1");
    router.refresh();
  }

  const counts = ROLES.map((r) => ({ r, n: fields.filter((f) => f.role === r).length }));
  const zi = ZOOMS.indexOf(zoom);
  const status = saved === "saving" ? "Saving…" : saved === "dirty" ? "Unsaved changes" : saved === "error" ? "Not saved" : "All changes saved";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="sticky top-14 z-20 mb-3 space-y-2 lg:top-2">
          <div role="toolbar" aria-label="Document" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 shadow-1">
            <div className="flex items-center gap-1">
              <ToolButton label="Zoom out" onClick={() => setZoom(ZOOMS[Math.max(0, zi - 1)])} disabled={zi <= 0}>−</ToolButton>
              <span className="w-12 text-center text-xs tabular text-ink-2" aria-live="polite" aria-label={`Zoom ${Math.round(zoom * 100)}% of the page width`}>
                {Math.round(zoom * 100)}%
              </span>
              <ToolButton label="Zoom in" onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)])} disabled={zi >= ZOOMS.length - 1}>+</ToolButton>
              <button type="button" onClick={() => setZoom(1)} disabled={zoom === 1} className="rounded-md px-2 py-1 text-xs font-medium text-ink-2 hover:bg-gray-100 disabled:text-gray-400">
                Fit width
              </button>
            </div>
            {pages.length > 1 && (
              <div className="flex items-center gap-1">
                <ToolButton label="Previous page" onClick={() => goToPage(page - 1)} disabled={page <= 0}>‹</ToolButton>
                <span className="text-xs whitespace-nowrap text-ink-2 tabular" aria-live="polite">
                  Page {page + 1} of {pages.length}
                </span>
                <ToolButton label="Next page" onClick={() => goToPage(page + 1)} disabled={page >= pages.length - 1}>›</ToolButton>
              </div>
            )}
            {!readOnly && (
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={undo} disabled={!canUndo} className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-brand/5 disabled:text-gray-400" title="Undo (⌘Z / Ctrl+Z)">
                  Undo
                </button>
                <span className={cx("text-xs", saved === "error" ? "font-medium text-bad" : "text-muted")} role="status">
                  {status}
                </span>
                {saved === "error" && (
                  <button type="button" onClick={() => save(fields)} className="text-xs font-medium text-brand underline">
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
          {selected && !readOnly && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-xs shadow-1 lg:hidden">
              <span className="min-w-0 truncate">
                Selected: <b>{selected.label || TYPE_LABEL[selected.type]}</b>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <a href="#field-details" className="font-medium text-brand">Details</a>
                <button type="button" className="font-medium text-bad" onClick={() => remove(selected.id)}>Delete</button>
              </span>
            </div>
          )}
          {placing && (
            <Notice tone="info">
              <span className="block">
                Click on the page where the <b>{placing.label.toLowerCase()}</b> goes.{" "}
                <button type="button" className="font-medium underline" onClick={() => setPlacing(null)}>Cancel</button>
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-2">
                Or put it on
                <select aria-label="Page to place it on" value={placePage} onChange={(e) => setPlacePage(Number(e.target.value))} className="rounded-md border border-line-strong bg-white px-1.5 py-0.5 text-sm">
                  {pages.map((_, i) => <option key={i} value={i}>page {i + 1}</option>)}
                </select>
                <button type="button" className="rounded-md border border-line-strong bg-white px-2 py-0.5 font-medium hover:bg-gray-50" onClick={() => place(placing, placePage, pages[placePage].width / 2, pages[placePage].height / 2)}>
                  Place in the middle
                </button>
              </span>
            </Notice>
          )}
        </div>
        <div className={cx("rounded-xl bg-gray-200/70 p-2 sm:p-4", placing && "ring-2 ring-brand/40")}>
          <PdfPages
            url={pdfUrl}
            pages={pages}
            zoom={zoom}
            onCurrentPage={onCurrentPage}
            className="overflow-x-auto"
            onPageClick={(pi, x, y) => {
              if (readOnly) return;
              if (!placing) return setSel(null);
              place(placing, pi, x, y);
            }}
            overlay={(pi, scale) =>
              fields
                .filter((f) => f.page === pi)
                .map((f) => {
                  const p = pages[pi];
                  const low = (f.confidence ?? 1) < LOW;
                  return (
                    <div
                      key={f.id}
                      data-field-id={f.id}
                      role="button"
                      tabIndex={0}
                      aria-label={fieldName(f)}
                      aria-pressed={sel === f.id}
                      onFocus={() => setSel(f.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSel(f.id);
                        }
                      }}
                      onPointerDown={(e) => {
                        if (readOnly) return;
                        e.stopPropagation();
                        e.preventDefault();
                        setSel(f.id);
                        (e.currentTarget as HTMLElement).focus({ preventScroll: true });
                        drag.current = { id: f.id, mode: "move", sx: e.clientX, sy: e.clientY, f, scale, moved: false };
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel(f.id);
                      }}
                      className={cx(
                        "group absolute flex items-center overflow-hidden rounded-[3px] border text-[10px] leading-none font-medium select-none focus-visible:outline-2 focus-visible:outline-offset-2",
                        ROLE_STYLE[f.role].box,
                        !readOnly && "cursor-move touch-none",
                        sel === f.id && "ring-2 ring-offset-1 ring-ink/70",
                        (low || overlapIds.has(f.id)) && "border-dashed",
                      )}
                      style={{ left: pct(f.x, p.width), top: pct(f.y, p.height), width: pct(f.w, p.width), height: pct(f.h, p.height) }}
                    >
                      <span className={cx("truncate px-1", f.type === "signature" ? "text-[11px]" : "")} style={{ fontSize: Math.max(8, Math.min(11, f.h * scale * 0.5)) }}>
                        {f.type === "checkbox" ? "" : f.role === "prefill" ? `⟨${f.label}⟩` : boxText(f)}
                      </span>
                      {low && <span className="absolute -top-0.5 right-0.5 text-[9px] text-amber-700">?</span>}
                      {!readOnly && (
                        <span
                          aria-hidden
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setSel(f.id);
                            drag.current = { id: f.id, mode: "resize", sx: e.clientX, sy: e.clientY, f, scale, moved: false };
                          }}
                          className={cx(
                            "absolute right-0 bottom-0 h-3.5 w-3.5 cursor-se-resize rounded-tl-sm [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:w-5",
                            ROLE_STYLE[f.role].solid,
                            sel === f.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                          )}
                        />
                      )}
                    </div>
                  );
                })
            }
          />
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto" aria-label="Fields">
        <div className="rounded-xl border border-line bg-white p-4">
          <h2 className="font-semibold">{readOnly ? "Fields" : "Review fields"}</h2>
          <p className="mt-1 text-xs text-muted">
            {detection.proposed} found automatically in {Math.max(1, Math.round(detection.ms / 100) / 10)}s{readOnly ? "." : "; nothing is trusted until you check it."}
            {firmName && ` Blocks under “${firmName}” are treated as your firm's.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {counts.map(({ r, n }) => (
              <span key={r} className={cx("rounded-full px-2 py-0.5 text-xs font-medium", ROLE_STYLE[r].chip)}>
                {n} {ROLE_LABEL[r].toLowerCase()}
              </span>
            ))}
          </div>
          {(detection.warnings.length > 0 || lowConf > 0 || overlaps.length > 0) && (
            <ul className="mt-3 space-y-1.5 text-xs text-amber-900">
              {detection.warnings.map((w, i) => (
                <li key={i} className="rounded-md bg-amber-50 px-2 py-1.5">{w}</li>
              ))}
              {lowConf > 0 && !readOnly && (
                <li className="rounded-md bg-amber-50 px-2 py-1.5">
                  {lowConf} field{lowConf === 1 ? "" : "s"} we weren&apos;t sure about {lowConf === 1 ? "has" : "have"} a dashed border and a “?”. Editing one marks it checked.
                </li>
              )}
              {overlaps.length > 0 && (
                <li className="rounded-md bg-amber-50 px-2 py-1.5">
                  {overlaps.length === 1 ? "Two fields cover each other" : `${overlaps.length} pairs of fields cover each other`}: {overlaps.slice(0, 2).map(([a, b]) => `“${a.label}” and “${b.label}” on page ${a.page + 1}`).join("; ")}. Move one if that isn&apos;t intended.
                </li>
              )}
            </ul>
          )}
          {err && <div className="mt-3"><Notice tone="error">{err}</Notice></div>}
          {!readOnly && (
            <div className="mt-4 space-y-2">
              {problems.length > 0 && (
                <ul className="space-y-1 text-xs text-bad" aria-label="Must fix before publishing">
                  {problems.slice(0, 3).map((p, i) => <li key={i}>• {p}</li>)}
                </ul>
              )}
              <Button className="w-full" onClick={() => { setChecked(false); setConfirming(true); }} disabled={publishing || problems.length > 0 || saved === "error"}>
                Review and publish
              </Button>
              <p className="text-[11px] text-muted">Publishing makes this version {versionNumber} the one every new file uses. It can&apos;t be edited afterwards.</p>
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
                  type="button"
                  aria-pressed={placing?.label === p.label}
                  onClick={() => {
                    setPlacePage(page);
                    setPlacing(placing?.label === p.label ? null : p);
                  }}
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
          <div id="field-details" className="scroll-mt-28 rounded-xl border border-line bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Selected field</h3>
              {!readOnly && <button type="button" className="text-xs font-medium text-bad" onClick={() => remove(selected.id)}>Delete field</button>}
            </div>
            <fieldset disabled={readOnly} className="space-y-3 text-sm" onFocusCapture={snapshot}>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Who completes it</span>
                <select className={inputCls} value={selected.role} onChange={(e) => {
                  const role = e.target.value as Role;
                  update(selected.id, { role, prefillKey: role === "prefill" ? selected.prefillKey ?? "client.name" : undefined, required: role === "client" ? selected.required : false });
                }}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <span className="mt-1 block text-[11px] text-muted">{ROLE_HELP[selected.role]}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Type</span>
                <select className={inputCls} value={selected.type} onChange={(e) => update(selected.id, { type: e.target.value as FieldType })}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Label</span>
                <input
                  className={inputCls}
                  value={selected.label}
                  maxLength={120}
                  onChange={(e) => {
                    const label = e.target.value;
                    // a blank asked at file creation keeps a key that matches its label
                    const key = selected.role === "prefill" && selected.prefillKey?.startsWith("custom.") ? `custom.${slug(label)}` : selected.prefillKey;
                    update(selected.id, { label, prefillKey: key && fields.some((f) => f.id !== selected.id && f.prefillKey === key) ? selected.prefillKey : key });
                  }}
                />
              </label>
              <div>
                <span className="mb-1 block text-xs font-medium text-muted">Position on page {selected.page + 1}, in points</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {([["x", "Left"], ["y", "Top"], ["w", "Width"], ["h", "Height"]] as const).map(([k, name]) => (
                    <label key={k} className="block">
                      <span className="mb-0.5 block text-[10px] font-medium text-muted">{name}</span>
                      <input
                        type="number"
                        step={1}
                        min={k === "w" || k === "h" ? 6 : 0}
                        className={cx(inputCls, "px-1.5 py-1 text-xs")}
                        value={Math.round(selected[k])}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) update(selected.id, { [k]: v } as Partial<Field>);
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
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
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={selected.required} onChange={(e) => update(selected.id, { required: e.target.checked })} />
                  <span>
                    Required
                    <span className="block text-[11px] text-muted">{selected.required ? "The client can't finish signing without it." : "Optional: the client may leave it blank."}</span>
                  </span>
                </label>
              )}
              {selected.reason && (
                <p className="rounded-md bg-gray-50 px-2 py-1.5 text-[11px] text-muted">
                  Why: {selected.reason}
                  {selected.confidence !== undefined && selected.confidence < 1 ? ` (confidence ${Math.round(selected.confidence * 100)}%)` : ""}
                </p>
              )}
              {!readOnly && <p className="text-[11px] text-muted">Drag to move and the corner to resize. With the field selected: arrow keys move it (Shift for 10pt), Alt + arrows resize it, Delete removes it, Esc deselects.</p>}
            </fieldset>
          </div>
        )}

        <div className="rounded-xl border border-line bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">All fields <span className="font-normal text-muted">({fields.length})</span></h3>
          {fields.length === 0 ? (
            <p className="text-xs text-muted">No fields yet. Add a client signature to publish.</p>
          ) : (
            <div className="space-y-3">
              {pages.map((_, pi) => {
                const fs = fields.filter((f) => f.page === pi).sort((a, b) => a.y - b.y || a.x - b.x);
                if (!fs.length) return null;
                return (
                  <div key={pi}>
                    <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Page {pi + 1}</div>
                    <ul className="space-y-0.5">
                      {fs.map((f) => (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => showField(f.id)}
                            aria-current={sel === f.id ? "true" : undefined}
                            className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-gray-50", sel === f.id && "bg-brand/5 ring-1 ring-brand/30")}
                          >
                            <span className={cx("h-2 w-2 shrink-0 rounded-full", ROLE_STYLE[f.role].solid)} aria-hidden />
                            <span className="min-w-0 flex-1 truncate">
                              {f.label || TYPE_LABEL[f.type]}
                              <span className="text-muted"> · {ROLE_LABEL[f.role]}</span>
                            </span>
                            {(f.confidence ?? 1) < LOW && <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-900">check</span>}
                            {overlapIds.has(f.id) && <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-900">overlaps</span>}
                            {f.role === "client" && <span className="shrink-0 text-[10px] text-muted">{f.required ? "Required" : "Optional"}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-white p-4 text-xs text-muted">
          <div className="mb-2 font-medium text-ink">Legend</div>
          <ul className="space-y-1">
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-blue-500" />Client signs or fills it in</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-violet-500" />Your firm: filled and signed automatically</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />Filled from the file (client name, fee, date…)</li>
            <li>Dashed border = please check (low confidence or overlapping)</li>
          </ul>
        </div>
      </aside>

      {confirming && (
        <Modal title={`Publish version ${versionNumber}?`} onClose={() => !publishing && setConfirming(false)}>
          <div className="space-y-3 text-sm">
            <p>
              <b>{templateName}</b>, version {versionNumber}: {counts.find((c) => c.r === "client")!.n} client field{counts.find((c) => c.r === "client")!.n === 1 ? "" : "s"} ({fields.filter((f) => f.role === "client" && f.required).length} required),{" "}
              {counts.find((c) => c.r === "firm")!.n} for your firm, {counts.find((c) => c.r === "prefill")!.n} filled from the file, over {pages.length} page{pages.length === 1 ? "" : "s"}.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-ink-2">
              <li>Every new file will use version {versionNumber}.</li>
              {live && (
                <li>
                  Version {live.version} stops being used for new files. The {live.files} client file{live.files === 1 ? "" : "s"} already sent with it stay on version {live.version}, exactly as sent.
                </li>
              )}
              <li>Published versions can&apos;t be edited. To change it later you create a new version.</li>
              {lowConf > 0 && <li className="text-amber-900">{lowConf} field{lowConf === 1 ? " is" : "s are"} still marked “check”.</li>}
              {overlaps.length > 0 && (
                <li className="text-amber-900">
                  {overlaps.length === 1 ? "Two fields cover each other" : `${overlaps.length} pairs of fields cover each other`}; the client may not be able to reach the one underneath.
                </li>
              )}
            </ul>
            <label className="flex items-start gap-2 rounded-md border border-line bg-subtle px-3 py-2">
              <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} autoFocus />
              <span>I&apos;ve checked every field against the document.</span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={publishing}>Cancel</Button>
              <Button type="button" onClick={publish} disabled={!checked} loading={publishing}>
                Publish version {versionNumber}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid h-7 w-7 place-items-center rounded-md text-base leading-none text-ink-2 hover:bg-gray-100 disabled:text-gray-300">
      {children}
    </button>
  );
}

/** Accessible name for a field box: its visible text first (WCAG 2.5.3), then who fills it. */
function fieldName(f: Field) {
  const shown = f.type === "checkbox" ? "" : f.role === "prefill" ? `⟨${f.label}⟩` : boxText(f);
  const who = `${ROLE_LABEL[f.role]}: ${f.label}`;
  return shown ? `${shown}. ${who}` : who;
}

// Show the field type on the box unless the label already says it, so a mistyped field stands out.
function boxText(f: Field) {
  const t = TYPE_LABEL[f.type];
  const word = t.split(" ").pop()!.toLowerCase();
  return f.label.toLowerCase().includes(word) || f.label === t ? f.label : `${t} · ${f.label}`;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}
