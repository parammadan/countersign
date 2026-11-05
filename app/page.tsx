import Link from "next/link";
import { getSession } from "@/lib/auth";
import { Logo } from "@/components/ui";

const steps = [
  { t: "Upload your agreement once", d: "PDF or Word, the same one you send today. We find where the client signs, initials and dates, and where your firm countersigns. You check it in a minute and publish." },
  { t: "Open a file, and it goes out", d: "From the app, your CRM, n8n or our API. The agreement is filled in with the client's details and emailed for signature right away." },
  { t: "Client signs on any device", d: "No account, no download. Consent, review, sign: about two minutes. Reminders go out on their own until it's done." },
  { t: "Countersigned and filed", d: "Your adopted signature is applied the moment they sign. Both sides get the sealed PDF with an audit certificate, and your systems get a webhook." },
];

const features = [
  ["Works with the agreement you already have", "Field detection reads your document's signature blocks, party names and blanks. No re-typing it into a template builder."],
  ["Nobody at the firm has to touch it", "Automatic sending, reminders, expiry and countersignature. Staff only step in when a client declines or a link expires."],
  ["Every file in one command center", "See who's waiting, for how long, and what's blocking work. Resend, remind or void in one click."],
  ["Holds up later", "ESIGN/UETA consent, an append-only audit trail with IPs and timestamps, SHA-256 seals, a certificate of completion, and a public verify page."],
  ["Fits your stack", "Inbound webhook for no-code tools, a REST API, signed outbound webhooks, and a ready-made n8n workflow."],
  ["Built for firms", "One workspace per firm with your branding, your sender name and your team. Versioned agreements, so every file records exactly what was signed."],
];

export default async function Home() {
  const s = await getSession();
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo className="text-lg" />
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/verify" className="hidden px-3 py-2 text-muted hover:text-ink sm:inline">Verify a document</Link>
          {s ? (
            <Link href="/app" className="rounded-lg bg-brand px-3.5 py-2 font-medium text-white">Open app</Link>
          ) : (
            <>
              <Link href="/login" className="px-3 py-2 text-muted hover:text-ink">Sign in</Link>
              <Link href="/signup" className="rounded-lg bg-brand px-3.5 py-2 font-medium text-white">Start free</Link>
            </>
          )}
        </nav>
      </header>
      <section className="mx-auto max-w-6xl px-4 pt-14 pb-16 sm:px-6 sm:pt-20">
        <p className="mb-4 text-sm font-semibold tracking-wide text-brand uppercase">For firms that start every job with a signed agreement</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">Your client agreement, signed on every file. Automatically.</h1>
        <p className="mt-6 max-w-2xl text-lg text-muted">
          Upload the agreement you already use. Each time a new job or case opens, Countersign sends it, chases it, countersigns it and files the signed copy, so work can start without anyone stopping to do paperwork.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/signup" className="rounded-lg bg-brand px-5 py-3 font-medium text-white shadow-sm hover:brightness-110">Create your workspace</Link>
          <Link href="/login" className="rounded-lg border border-line px-5 py-3 font-medium text-ink hover:bg-gray-50">Sign in</Link>
        </div>
      </section>
      <section className="border-y border-line bg-bg">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {steps.map((st, i) => (
            <div key={st.t}>
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">{i + 1}</div>
              <h3 className="font-semibold">{st.t}</h3>
              <p className="mt-1.5 text-sm text-muted">{st.d}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([t, d]) => (
            <div key={t}>
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-1.5 text-sm text-muted">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted sm:flex-row sm:justify-between sm:px-6">
          <span>Countersign: electronic signatures under the U.S. ESIGN Act and UETA.</span>
          <Link href="/verify" className="hover:text-ink">Verify a signed document</Link>
        </div>
      </footer>
    </div>
  );
}
