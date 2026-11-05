"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PdfPages, pct } from "./PdfPages";
import { Modal, SignaturePad, type Adopted } from "./SignaturePad";
import { Button, Notice, cx, inputCls } from "./ui";
import { CONSENT_FULL, CONSENT_SUMMARY, SIGN_INTENT } from "@/lib/consent";
import type { Field, PageSize } from "@/lib/fields";

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

  const mine = useMemo(() => p.fields.filter((f) => f.role === "client").sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [p.fields]);
  const isDone = (f: SignerField) => {
    if (f.type === "signature") return !!sig;
    if (f.type === "initials") return !!ini;
    if (f.type === "date") return true;
    if (f.type === "checkbox") return values[f.id] === true;
    return typeof values[f.id] === "string" && (values[f.id] as string).trim() !== "";
  };
  const required = mine.filter((f) => f.required || f.type === "signature" || f.type === "initials");
  const remaining = required.filter((f) => !isDone(f));
  const progress = required.length ? Math.round(((required.length - remaining.length) / required.length) * 100) : 100;

  function goTo(f: SignerField | undefined) {
    if (!f) return;
    const el = document.querySelector(`[data-fid="${f.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement | null)?.focus({ preventScroll: true });
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
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || "Something went wrong");
      setConfirm(false);
      setStage("done");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (stage === "done") return <Done token={p.token} firm={p.firm} email={p.clientEmail} />;
  if (stage === "otp") return <Otp token={p.token} email={p.clientEmail} onOk={() => setStage(p.consented ? "sign" : "intro")} />;

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
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">2</span>Fill in the {required.length} marked field{required.length === 1 ? "" : "s"}</li>
            <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">3</span>Sign. We email you the signed copy</li>
          </ol>
          <label className="mt-6 flex items-start gap-3 rounded-lg border border-line bg-gray-50 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              {CONSENT_SUMMARY}{" "}
              <button type="button" className="font-medium text-brand underline" onClick={() => setShowDisclosure(true)}>Read the disclosure</button>
            </span>
          </label>
          <Button className="mt-5 w-full py-2.5" disabled={!consent} onClick={() => setStage("sign")}>Review and sign</Button>
          <button className="mt-3 w-full text-center text-xs text-muted hover:text-ink" onClick={() => setDeclining(true)}>I don&apos;t want to sign this</button>
        </div>
        <p className="mt-4 text-center text-xs text-muted">Sent to {p.clientEmail}. Secured by Countersign.</p>
        {showDisclosure && <Disclosure onClose={() => setShowDisclosure(false)} />}
        {declining && <Decline token={p.token} onClose={() => setDeclining(false)} />}
      </div>
    );

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{p.agreement}</div>
            <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-gray-100">
              <div className="h-full bg-brand transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <span className="hidden text-xs text-muted sm:inline">{remaining.length ? `${remaining.length} left` : "Ready to sign"}</span>
          {remaining.length > 0 ? (
            <Button onClick={() => goTo(remaining[0])}>Next field</Button>
          ) : (
            <Button onClick={() => setConfirm(true)}>Finish</Button>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-4xl px-2 pt-4 sm:px-4">
        {err && <div className="mb-3"><Notice tone="error">{err}</Notice></div>}
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
                    aria-label={`${f.label}${f.required ? " (required)" : ""}`}
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
        <div className="mx-auto mt-6 max-w-xl text-center">
          {remaining.length ? (
            <Button onClick={() => goTo(remaining[0])}>Go to the next required field ({remaining.length} left)</Button>
          ) : (
            <Button className="px-6 py-2.5" onClick={() => setConfirm(true)}>Finish and sign</Button>
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
            {sig && (
              <div className="rounded-lg border border-line bg-gray-50 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sig.png} alt="Your signature" className="h-14 object-contain" />
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
      {declining && <Decline token={p.token} onClose={() => setDeclining(false)} />}
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
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title={field.label || "Fill in"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v.trim());
        }}
        className="space-y-4"
      >
        <input ref={ref} className={inputCls} value={v} onChange={(e) => setV(e.target.value)} maxLength={300} type={field.type === "email" ? "email" : "text"} required={field.required} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button>Save</Button>
        </div>
      </form>
    </Modal>
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

function Decline({ token, onClose }: { token: string; onClose: () => void }) {
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
            if (r.ok) setDone(true);
            else setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't decline");
          }}
        >
          <p className="text-sm text-muted">Tell the sender why. They&apos;ll get your message and can send a revised agreement.</p>
          <textarea className={cx(inputCls, "min-h-24")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required />
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

function Otp({ token, email, onOk }: { token: string; email: string; onOk: () => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/sign/${token}/otp`, { method: "POST" });
    const j = (await r.json().catch(() => ({}))) as { to?: string; error?: string };
    setBusy(false);
    if (r.ok) setSent(j.to ?? email);
    else setErr(j.error ?? "Couldn't send the code");
  }
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
        <p className="mt-1 text-sm text-muted">We&apos;ll email a 6-digit code to the address this agreement was sent to.</p>
        {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
        {!sent ? (
          <Button className="mt-5 w-full" onClick={send} disabled={busy}>{busy ? "Sending…" : "Email me a code"}</Button>
        ) : (
          <form
            className="mt-5 space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              const r = await fetch(`/api/sign/${token}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
              setBusy(false);
              if (r.ok) onOk();
              else setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Wrong code");
            }}
          >
            <p className="text-sm">Code sent to <b>{sent}</b>.</p>
            <input className={cx(inputCls, "text-center text-2xl tracking-[0.5em]")} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
            <Button className="w-full" disabled={busy || code.length !== 6}>Verify</Button>
            <button type="button" className="w-full text-xs text-muted" onClick={send}>Send a new code</button>
          </form>
        )}
      </div>
    </div>
  );
}

function Done({ token, firm, email }: { token: string; firm: string; email: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <div className="rounded-2xl border border-line bg-white p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">All signed</h1>
        <p className="mt-2 text-sm text-muted">
          Thanks. {firm} has your signature. A copy of the completed agreement and its audit certificate is on its way to {email}.
        </p>
        <a href={`/api/sign/${token}/download`} className="mt-6 inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:brightness-110">
          Download signed copy
        </a>
        <p className="mt-3 text-xs text-muted">If the download says it isn&apos;t ready, the countersignature is still pending. You&apos;ll get an email when it&apos;s done.</p>
      </div>
    </div>
  );
}
