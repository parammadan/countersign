"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PdfPages, pct } from "./PdfPages";
import { Modal, SignaturePad, signerInputCls, touchFirst, type Adopted } from "./SignaturePad";
import { Button, Notice, cx, inputCls } from "./ui";
import { CONSENT_FULL, CONSENT_SUMMARY, SIGN_INTENT } from "@/lib/consent";
import type { Field, PageSize } from "@/lib/fields";
import { BRAND } from "@/lib/brand";
import { autoCompleteFor, fieldError, fieldName, mustComplete, progressText, remainingAnnouncement } from "@/lib/sign-fields";

export type SignerField = Field & { value?: string };

type Props = {
  token: string;
  firm: string;
  agreement: string;
  title: string;
  clientName: string;
  clientEmail: string;
  clientCompany: string | null;
  pages: PageSize[];
  fields: SignerField[];
  today: string;
  requireOtp: boolean;
  otpVerified: boolean;
  consented: boolean;
};

export function SigningRoom(p: Props) {
  const [doneStatus, setDoneStatus] = useState<"signed" | "completed">("signed");
  const [stage, setStage] = useState<"otp" | "intro" | "sign" | "done">(p.requireOtp && !p.otpVerified ? "otp" : p.consented ? "sign" : "intro");
  const [consent, setConsent] = useState(p.consented);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [sig, setSig] = useState<Adopted | null>(null);
  const [ini, setIni] = useState<Adopted | null>(null);
  const [pad, setPad] = useState<null | "signature" | "initials">(null);
  const [editing, setEditing] = useState<SignerField | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const v: Record<string, string | boolean> = {};
    for (const f of p.fields) {
      if (f.role !== "client") continue;
      if (f.type === "name") v[f.id] = p.clientName;
      else if (f.type === "email") v[f.id] = p.clientEmail;
      else if (f.type === "company" && p.clientCompany) v[f.id] = p.clientCompany;
      else if (f.type === "checkbox") v[f.id] = false;
    }
    return v;
  });
  const [confirm, setConfirm] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pendingField = useRef<string | null>(null);
  // A phone can reload or discard the tab mid-signing. What the client has filled in and adopted is kept
  // for this tab only (sessionStorage, gone when the tab closes, cleared on finishing or declining), so
  // they pick up where they were. Nothing here reaches the server until they press "Sign and finish".
  const draftKey = `cs-sign-draft:${p.token.slice(-12)}`;
  const [resumed, setResumed] = useState(false);
  const draftReady = useRef(false);
  // restoring has to wait until after hydration (the server can't see this tab's storage), so it runs once in an
  // effect; the set-state-in-effect rule is disabled for exactly that
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const d = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as { values?: Record<string, unknown>; sig?: Adopted; ini?: Adopted } | null;
      if (d && typeof d === "object") {
        const ok = (a?: Adopted) => !!a && typeof a.png === "string" && a.png.startsWith("data:image/png;base64,") && (a.method === "drawn" || a.method === "typed");
        const ids = new Map(p.fields.filter((f) => f.role === "client").map((f) => [f.id, f.type]));
        const vals: Record<string, string | boolean> = {};
        for (const [k, v] of Object.entries(d.values ?? {})) {
          const t = ids.get(k);
          if (t === "checkbox" && typeof v === "boolean") vals[k] = v;
          else if (t && t !== "checkbox" && typeof v === "string") vals[k] = v.slice(0, 300);
        }
        if (Object.keys(vals).length) setValues((v) => ({ ...v, ...vals }));
        if (ok(d.sig)) setSig(d.sig!);
        if (ok(d.ini)) setIni(d.ini!);
        if (ok(d.sig) || ok(d.ini) || Object.keys(vals).length) setResumed(true);
      }
    } catch {}
    draftReady.current = true;
  }, [draftKey, p.fields]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!draftReady.current || stage !== "sign") return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ values, sig, ini }));
    } catch {}
  }, [draftKey, stage, values, sig, ini]);
  const forgetDraft = () => {
    try {
      sessionStorage.removeItem(draftKey);
    } catch {}
  };
  useEffect(() => {
    if (stage !== "otp") fetch(`/api/sign/${p.token}/viewed`, { method: "POST" }).catch(() => {});
  }, [stage, p.token]);

  const mine = useMemo(() => p.fields.filter((f) => f.role === "client").sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [p.fields]);
  const isDone = (f: SignerField) => {
    if (f.type === "signature") return !!sig;
    if (f.type === "initials") return !!ini;
    if (f.type === "date") return true;
    if (f.type === "checkbox") return values[f.id] === true;
    return typeof values[f.id] === "string" && (values[f.id] as string).trim() !== "";
  };
  const required = mine.filter(mustComplete);
  const remaining = required.filter((f) => !isDone(f));
  // optional fields the client hasn't looked at yet (they can skip them, but we walk them through)
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const optionalLeft = mine.filter((f) => !required.includes(f) && f.type !== "date" && !isDone(f) && !skipped.has(f.id));
  const doneCount = required.length - remaining.length;
  const progress = required.length ? Math.round((doneCount / required.length) * 100) : 100;
  // tell screen-reader users how far along they are each time a required field is completed or undone
  const [announce, setAnnounce] = useState("");
  const lastLeft = useRef(remaining.length);
  useEffect(() => {
    if (lastLeft.current !== remaining.length) setAnnounce(remainingAnnouncement(remaining.length));
    lastLeft.current = remaining.length;
  }, [remaining.length]);

  function goTo(f: SignerField | undefined) {
    if (!f) return;
    const el = document.querySelector(`[data-fid="${f.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // "Next field" goes to the field. On a touch screen it also opens its pad or text box, so a box on the page
  // that is hard to hit with a finger needn't be tapped; a checkbox is only shown, never ticked for them. With a
  // mouse or keyboard the field is focused and Enter (or a click) opens it.
  function next(f: SignerField | undefined) {
    if (!f) return;
    goTo(f);
    if (f.type !== "checkbox" && touchFirst()) activate(f);
  }

  function activate(f: SignerField) {
    if (f.type === "signature") {
      pendingField.current = f.id;
      setPad("signature");
    } else if (f.type === "initials") {
      pendingField.current = f.id;
      setPad("initials");
    } else if (f.type === "checkbox") setValues((v) => ({ ...v, [f.id]: !v[f.id] }));
    else if (f.type !== "date") setEditing(f);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/sign/${p.token}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, values, signature: sig?.png, initials: ini?.png, method: sig?.method ?? ini?.method ?? "typed" }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!r.ok) throw new Error(j.error || "Something went wrong");
      setDoneStatus(j.status === "completed" ? "completed" : "signed");
      setConfirm(false);
      forgetDraft();
      setStage("done");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (stage === "done") return <Done token={p.token} firm={p.firm} email={p.clientEmail} status={doneStatus} />;
  if (stage === "otp") return <Otp token={p.token} email={p.clientEmail} onOk={() => location.reload()} />;

  if (stage === "intro")
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <div className="rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
          <div className="text-sm font-semibold text-brand">{p.firm}</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Hi {p.clientName.split(" ")[0]}, your {p.agreement} is ready</h1>
          <p className="mt-2 text-sm text-muted">
            For <b className="text-ink">{p.title}</b>. Read it through, add your signature where it&apos;s marked, and you&apos;re done. About 2 minutes.
          </p>
          <ol className="mt-5 space-y-2 text-sm">
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">1</span>Review the agreement</li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">2</span>Fill in the {required.length} required field{required.length === 1 ? "" : "s"}{mine.length - required.length > 0 ? " (and any optional ones that apply)" : ""}</li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">3</span>Sign. We email you the signed copy</li>
          </ol>
          <label className="mt-6 flex items-start gap-3 rounded-lg border border-line bg-gray-50 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              {CONSENT_SUMMARY}{" "}
              <button type="button" className="font-medium text-brand underline" onClick={() => setShowDisclosure(true)}>Read the disclosure</button>
            </span>
          </label>
          <Button
            className="mt-5 w-full py-2.5"
            disabled={!consent}
            onClick={() => {
              fetch(`/api/sign/${p.token}/consent`, { method: "POST" }).catch(() => {});
              setStage("sign");
            }}
          >
            Review and sign
          </Button>
          {!consent && <p className="mt-2 text-center text-xs text-muted">Tick the box above to continue.</p>}
          <button className="mt-3 w-full text-center text-xs text-muted hover:text-ink" onClick={() => setDeclining(true)}>I don&apos;t want to sign this</button>
        </div>
        <p className="mt-4 text-center text-xs text-muted">Sent to {p.clientEmail}. Secured by {BRAND.name}.</p>
        {showDisclosure && <Disclosure onClose={() => setShowDisclosure(false)} />}
        {declining && <Decline token={p.token} onClose={() => setDeclining(false)} onDeclined={forgetDraft} />}
      </div>
    );

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold">{p.agreement}</span>
              <a href={`/api/sign/${p.token}/pdf`} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">Download PDF</a>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div
                role="progressbar"
                aria-label="Required fields done"
                aria-valuemin={0}
                aria-valuemax={required.length}
                aria-valuenow={doneCount}
                aria-valuetext={`${doneCount} of ${required.length} required fields done`}
                className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-gray-100"
              >
                <div className="h-full bg-brand transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="shrink-0 text-[11px] font-medium text-muted" aria-hidden="true">{progressText(doneCount, required.length, optionalLeft.length)}</span>
            </div>
          </div>
          {remaining.length > 0 ? (
            <Button onClick={() => next(remaining[0])}>Next field</Button>
          ) : (
            <>
              {optionalLeft.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const f = optionalLeft[0];
                    setSkipped((s) => new Set(s).add(f.id));
                    goTo(f);
                    activate(f);
                  }}
                >
                  Optional field
                </Button>
              )}
              <Button onClick={() => setConfirm(true)}>Finish</Button>
            </>
          )}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <div className="mx-auto max-w-4xl px-2 pt-4 sm:px-4">
        {err && !confirm && <div className="mb-3"><Notice tone="error">{err}</Notice></div>}
        {resumed && (
          <div className="mx-auto mb-3 max-w-xl">
            <Notice>We kept what you&apos;d already filled in on this device. Check it, then carry on.</Notice>
          </div>
        )}
        <PdfPages
          url={`/api/sign/${p.token}/pdf`}
          pages={p.pages}
          overlay={(page, scale) =>
            p.fields
              .filter((f) => f.page === page)
              .map((f) => {
                const ps = p.pages[page];
                const style = { left: pct(f.x, ps.width), top: pct(f.y, ps.height), width: pct(f.w, ps.width), height: pct(f.h, ps.height) };
                const fontSize = Math.max(7, Math.min(14, f.h * scale * 0.62));
                if (f.role === "prefill")
                  return f.value ? (
                    <div key={f.id} className="pointer-events-none absolute flex items-center overflow-hidden whitespace-nowrap text-[#0d1f59]" style={{ ...style, fontSize }}>
                      {f.value}
                    </div>
                  ) : null;
                if (f.role === "firm")
                  return (
                    <div key={f.id} className="pointer-events-none absolute flex items-center justify-center overflow-hidden rounded-sm border border-dashed border-violet-300 bg-violet-50/60 text-violet-700" style={{ ...style, fontSize: Math.max(7, fontSize * 0.7) }}>
                      {f.type === "signature" && <span className="truncate px-1">{p.firm} signs after you</span>}
                    </div>
                  );
                const done = isDone(f);
                const img = f.type === "signature" ? sig?.png : f.type === "initials" ? ini?.png : undefined;
                const text = f.type === "date" ? p.today : f.type === "checkbox" ? (values[f.id] ? "✓" : "") : (values[f.id] as string | undefined);
                return (
                  <button
                    key={f.id}
                    data-fid={f.id}
                    type="button"
                    onClick={() => activate(f)}
                    {...(f.type === "checkbox" ? { role: "checkbox", "aria-checked": done } : {})}
                    aria-label={signFieldName(f, img || f.type === "checkbox" ? "" : text ? text : f.type === "signature" ? "Sign here" : f.type === "initials" ? "Initial" : `${f.label}${f.required ? " *" : ""}`)}
                    className={cx(
                      "absolute flex items-center overflow-hidden rounded-[3px] border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                      done ? "border-transparent bg-emerald-50/40 hover:border-emerald-300" : "animate-[pulse_2.5s_ease-in-out_infinite] border-brand bg-brand/10 hover:bg-brand/20",
                      f.type === "date" && "cursor-default",
                    )}
                    style={style}
                  >
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt="" className="h-full max-w-full object-contain object-left" />
                    ) : text ? (
                      <span className="truncate px-0.5 text-[#0d1f59]" style={{ fontSize, fontWeight: f.type === "checkbox" ? 700 : 400 }}>{text}</span>
                    ) : (
                      <span className="truncate px-1 font-medium text-brand" style={{ fontSize: Math.max(7, fontSize * 0.8) }}>
                        {f.type === "signature" ? "Sign here" : f.type === "initials" ? "Initial" : f.label}
                        {f.required && f.type !== "signature" && f.type !== "initials" ? " *" : ""}
                      </span>
                    )}
                  </button>
                );
              })
          }
        />
        <FieldList
          fields={mine.filter((f) => f.type !== "date")}
          isDone={isDone}
          onPick={(f) => {
            // a checkbox row is a checkbox: it ticks in place, like the box on the page; other rows open their field
            if (f.type === "checkbox") return activate(f);
            goTo(f);
            activate(f);
          }}
        />
        <div className="mx-auto mt-6 max-w-xl text-center">
          {remaining.length ? (
            <Button onClick={() => next(remaining[0])}>Go to the next required field ({remaining.length} left)</Button>
          ) : (
            <>
              {optionalLeft.length > 0 && (
                <p className="mb-3 text-sm text-muted">
                  {optionalLeft.length} optional field{optionalLeft.length === 1 ? "" : "s"} left ({optionalLeft.map((f) => f.label).slice(0, 3).join(", ")}). Fill {optionalLeft.length === 1 ? "it" : "them"} in if {optionalLeft.length === 1 ? "it applies" : "they apply"}, or finish now.
                </p>
              )}
              <Button className="px-6 py-2.5" onClick={() => setConfirm(true)}>Finish and sign</Button>
            </>
          )}
          <div className="mt-3">
            <button className="text-xs text-muted hover:text-ink" onClick={() => setDeclining(true)}>Decline to sign</button>
          </div>
        </div>
      </div>

      {pad && (
        <Modal title={pad === "signature" ? "Adopt your signature" : "Adopt your initials"} onClose={() => setPad(null)}>
          <SignaturePad
            mode={pad}
            defaultName={(Object.entries(values).find(([k]) => mine.find((m) => m.id === k)?.type === "name")?.[1] as string) || p.clientName}
            onCancel={() => setPad(null)}
            onAdopt={(a) => {
              if (pad === "signature") setSig(a);
              else setIni(a);
              setPad(null);
              const next = mine.find((f) => f.id !== pendingField.current && !isDoneAfter(f, pad, a));
              if (next) setTimeout(() => goTo(next), 150);
            }}
          />
          <p className="mt-4 text-[11px] text-muted">This {pad === "signature" ? "signature" : "set of initials"} is applied to every {pad === "signature" ? "signature" : "initials"} field in this agreement.</p>
        </Modal>
      )}

      {editing && (
        <TextModal
          field={editing}
          value={(values[editing.id] as string) ?? ""}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            setValues((s) => ({ ...s, [editing.id]: v }));
            const id = editing.id;
            setEditing(null);
            const next = required.find((f) => f.id !== id && !isDone(f));
            if (next) setTimeout(() => goTo(next), 150);
          }}
        />
      )}

      {confirm && (
        <Modal title="Sign and finish" onClose={() => !busy && setConfirm(false)}>
          <div className="space-y-4 text-sm">
            {(sig || ini) && (
              <div className="flex flex-wrap items-end gap-4 rounded-lg border border-line bg-gray-50 p-3">
                {sig && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={sig.png} alt="Your signature" className="h-14 max-w-full object-contain" />
                )}
                {ini && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ini.png} alt="Your initials" className="h-10 object-contain" />
                )}
                <span className="ml-auto text-xs text-muted">Dated {p.today}</span>
              </div>
            )}
            <p>{SIGN_INTENT}</p>
            <p className="text-muted">
              Signing as <b className="text-ink">{p.clientName}</b> ({p.clientEmail}). Your IP address and the time are recorded on the audit certificate.
            </p>
            {err && <Notice tone="error">{err}</Notice>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>Back</Button>
              <Button onClick={submit} disabled={busy}>{busy ? "Signing…" : "Sign and finish"}</Button>
            </div>
          </div>
        </Modal>
      )}
      {declining && <Decline token={p.token} onClose={() => setDeclining(false)} onDeclined={forgetDraft} />}
    </div>
  );

  function isDoneAfter(f: SignerField, kind: "signature" | "initials", _a: Adopted) {
    if (f.type === kind) return true;
    if (f.type === "signature") return !!sig || kind === "signature";
    if (f.type === "initials") return !!ini || kind === "initials";
    if (!f.required) return true;
    return isDone(f);
  }
}

function TextModal({ field, value, onSave, onClose }: { field: SignerField; value: string; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  const [shown, setShown] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  // on a touch screen the keyboard opens only when the person taps the box (Modal focuses the dialog instead)
  useEffect(() => {
    if (!touchFirst()) ref.current?.focus();
  }, []);
  const name = fieldName(field);
  const needed = mustComplete(field);
  const id = `fill-${field.id}`;
  return (
    <Modal title={name || "Fill in"} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const problem = fieldError(field, v);
          if (problem) {
            setShown(problem);
            ref.current?.focus();
            return;
          }
          onSave(v.trim());
        }}
        className="space-y-4"
      >
        <div>
          <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
            {name} <span className="font-normal text-muted">({needed ? "required" : "optional"})</span>
          </label>
          <input
            ref={ref}
            id={id}
            className={cx(signerInputCls, shown && "border-bad")}
            value={v}
            onChange={(e) => {
              setV(e.target.value);
              if (shown) setShown(fieldError(field, e.target.value));
            }}
            maxLength={300}
            type={field.type === "email" ? "email" : "text"}
            inputMode={field.type === "email" ? "email" : undefined}
            autoComplete={autoCompleteFor(field.type)}
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? `${id}-err` : undefined}
          />
          {shown && <p id={`${id}-err`} role="alert" className="mt-1.5 text-sm text-bad">{shown}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Every field the client completes, with its state: a way to reach each one without hunting through the PDF. */
function FieldList({ fields, isDone, onPick }: { fields: SignerField[]; isDone: (f: SignerField) => boolean; onPick: (f: SignerField) => void }) {
  if (!fields.length) return null;
  return (
    <section aria-labelledby="your-fields" className="mx-auto mt-6 max-w-xl rounded-xl border border-line bg-white p-4 text-left">
      <h2 id="your-fields" className="text-sm font-semibold">Your fields</h2>
      <ul className="mt-2 divide-y divide-line" aria-label="Your fields">
        {fields.map((f) => {
          const done = isDone(f);
          const state = done ? "done" : mustComplete(f) ? "to do" : "optional";
          const box = f.type === "checkbox";
          return (
            <li key={f.id}>
              <button type="button" onClick={() => onPick(f)} {...(box ? { role: "checkbox", "aria-checked": done } : {})} className="flex min-h-11 w-full items-center gap-3 py-2 text-left text-sm hover:text-brand">
                <span aria-hidden="true" className={cx("flex h-5 w-5 shrink-0 items-center justify-center border text-[11px]", box ? "rounded-[4px]" : "rounded-full", done ? "border-ok bg-ok-bg text-ok" : "border-line-strong text-transparent")}>✓</span>
                <span className="min-w-0 flex-1 truncate">{fieldName(f)}</span>
                <span className="shrink-0 text-xs text-muted">Page {f.page + 1}</span>
                <span aria-hidden={box && done ? true : undefined} className={cx("w-16 shrink-0 text-right text-xs font-medium", done ? "text-ok" : mustComplete(f) ? "text-brand" : "text-muted")}>
                  <span className="sr-only">, </span>
                  {state === "done" ? "Done" : state === "to do" ? "Required" : "Optional"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Disclosure({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={CONSENT_FULL[0]} onClose={onClose} wide>
      <div className="space-y-3 text-sm leading-relaxed text-ink">
        {CONSENT_FULL.slice(1).map((t, i) => <p key={i}>{t}</p>)}
      </div>
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

function Decline({ token, onClose, onDeclined }: { token: string; onClose: () => void; onDeclined?: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={done ? "Declined" : "Decline to sign"} onClose={() => (done ? location.reload() : onClose())}>
      {done ? (
        <p className="text-sm">We&apos;ve let the sender know. You can close this page.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await fetch(`/api/sign/${token}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
            setBusy(false);
            if (r.ok) {
              onDeclined?.();
              setDone(true);
            }
            else setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't decline");
          }}
        >
          <p className="text-sm text-muted">Tell the sender why. They&apos;ll get your message and can send a revised agreement.</p>
          <textarea className={cx(signerInputCls, "min-h-24")} aria-label="Why you're declining" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required />
          {err && <Notice tone="error">{err}</Notice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="danger" disabled={busy}>Decline</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function VerifyThenDownload({ token, email }: { token: string; email: string }) {
  return <Otp token={token} email={email} onOk={() => location.reload()} />;
}

const RESEND_WAIT_S = 30;

function Otp({ token, email, onOk }: { token: string; email: string; onOk: () => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  async function send() {
    setBusy(true);
    setErr(null);
    const again = !!sent;
    const r = await fetch(`/api/sign/${token}/otp`, { method: "POST" });
    const j = (await r.json().catch(() => ({}))) as { to?: string; error?: string };
    setBusy(false);
    if (r.ok) {
      setSent(j.to ?? email);
      setResent(again);
      setCode("");
      setWait(RESEND_WAIT_S);
      setTimeout(() => input.current?.focus(), 0);
    } else setErr(j.error ?? "Couldn't send the code");
  }
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
        <p className="mt-1 text-sm text-muted">
          Before you see the agreement, we&apos;ll email a 6-digit code to <b className="text-ink">{email}</b>, the address it was sent to.
        </p>
        {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
        {!sent ? (
          <Button className="mt-5 w-full" onClick={send} disabled={busy}>{busy ? "Sending…" : "Email me a code"}</Button>
        ) : (
          <form
            className="mt-5 space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (code.length !== 6) return;
              setBusy(true);
              setErr(null);
              const r = await fetch(`/api/sign/${token}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
              setBusy(false);
              if (r.ok) onOk();
              else {
                setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Wrong code");
                input.current?.select();
              }
            }}
          >
            <p className="text-sm" role="status">
              {resent ? "New code sent to " : "Code sent to "}
              <b>{sent}</b>.{resent ? " Only the newest code works." : " It expires in 10 minutes."}
            </p>
            <label htmlFor="otp-code" className="block text-sm font-medium">6-digit code</label>
            <input
              ref={input}
              id="otp-code"
              className={cx(inputCls, "text-center text-2xl tracking-[0.5em]")}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              // pasted codes often carry spaces or a dash ("123 456"): keep the digits, then the first six
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-invalid={err ? true : undefined}
              autoFocus
            />
            <Button className="w-full" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify"}</Button>
            <button type="button" className="min-h-10 w-full text-xs text-muted hover:text-ink disabled:hover:text-muted" onClick={send} disabled={busy || wait > 0}>
              {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Done({ token, firm, email, status }: { token: string; firm: string; email: string; status: "signed" | "completed" }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const complete = status === "completed";
  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <div className="rounded-2xl border border-line bg-white p-6 text-center shadow-sm sm:p-8">
        <div aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div>
        <h1 ref={heading} tabIndex={-1} className="mt-4 text-2xl font-semibold tracking-tight outline-none">All signed</h1>
        {complete ? (
          <p className="mt-2 text-sm text-muted">
            Thanks. Both you and {firm} have signed, so the agreement is complete. A copy with its audit certificate is on its way to {email}, and you can download it now.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Thanks. {firm} has your signature and countersigns next. We&apos;ll email the completed agreement and its audit certificate to {email} as soon as they do.
          </p>
        )}
        <ol className="mx-auto mt-5 max-w-xs space-y-2 text-left text-sm" aria-label="Where this agreement is">
          <Step done label="You signed" />
          <Step done={complete} label={complete ? `${firm} countersigned` : `${firm} countersigns`} />
          <Step done={complete} label="Completed copy emailed to you" />
        </ol>
        {complete && (
          <a href={`/api/sign/${token}/download`} className="mt-6 inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:brightness-110">
            Download signed copy
          </a>
        )}
        <p className="mt-4 text-xs text-muted">You can close this page. This link opens your signed copy for 30 days once it&apos;s complete.</p>
      </div>
    </div>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-3">
      <span aria-hidden="true" className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]", done ? "border-ok bg-ok-bg text-ok" : "border-line-strong text-transparent")}>✓</span>
      <span className={done ? "" : "text-muted"}>{label}</span>
      <span className="sr-only">{done ? "(done)" : "(next)"}</span>
    </li>
  );
}

/** Accessible name for a field button: what the client sees on it first (WCAG 2.5.3), then what it is. */
function signFieldName(f: { label: string; required: boolean }, shown: string) {
  const what = `${f.label}${f.required ? " (required)" : ""}`;
  return shown && shown !== f.label ? `${shown}: ${what}` : what;
}
