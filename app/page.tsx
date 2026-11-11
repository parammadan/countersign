import Link from "next/link";
import { DemoVideo } from "@/components/landing/DemoVideo";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getSession } from "@/lib/auth";
import { LinkButton, Logo, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { BRAND } from "@/lib/brand";
import { MobileMenu, type MenuItem } from "@/components/landing/MobileMenu";
import {
  CLAUSES,
  CTA,
  DOC_INTEL,
  FEATURES,
  FEATURES_INTRO,
  FOOTER,
  HERO,
  HOW,
  KNOWLEDGE,
  NAV,
  DEMO,
  PHONE_SCAN,
  PHONE_SCAN_COPY,
  PHONE_SIGN,
  SIGN,
  STEPS,
  STUDIO,
  VOICE_INPUT,
  VOICE_INPUT_COPY,
  type Feature,
} from "@/components/landing/copy";
import {
  ClausePreview,
  DocumentPreview,
  HeroStudioPreview,
  KnowledgePreview,
  NewFilePreview,
  PhoneSignPreview,
  PhoneSigningPreview,
  SealedPreview,
  StudioDraftPreview,
} from "@/components/landing/Previews";

export const metadata: Metadata = {
  title: { absolute: `${BRAND.name}: ${HERO.eyebrow}` },
  description: HERO.subtitle,
};

const navLink = "rounded-md px-2.5 py-2 text-[14px] whitespace-nowrap sm:px-3 text-ink-2 transition-colors hover:text-ink";
const wrap = "mx-auto w-full max-w-6xl px-4 sm:px-6";

function Eyebrow({ children, icon, dark }: { children: ReactNode; icon?: Feature["icon"]; dark?: boolean }) {
  return (
    <p className={cx("inline-flex items-center gap-2 text-[13px] font-semibold tracking-[0.08em] uppercase", dark ? "text-indigo-200" : "text-brand")}>
      {icon && (
        <span className={cx("grid h-6 w-6 place-items-center rounded-md", dark ? "bg-white/10 text-indigo-100" : "bg-brand-soft text-brand")}>
          <Icon name={icon} size={14} />
        </span>
      )}
      {children}
    </p>
  );
}

function Points({ items, dark }: { items: readonly string[]; dark?: boolean }) {
  return (
    <ul className="mt-6 space-y-3">
      {items.map((p) => (
        <li key={p} className={cx("flex gap-3 text-[15px] leading-snug", dark ? "text-slate-200" : "text-ink-2")}>
          <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", dark ? "bg-white/10 text-indigo-200" : "bg-brand-soft text-brand")}>
            <Icon name="check" size={12} />
          </span>
          <span className="min-w-0">{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** A short highlighted note under a feature, e.g. a capability behind a flag. */
function Callout({ icon, label, dark, children }: { icon: Feature["icon"]; label: string; dark?: boolean; children: ReactNode }) {
  return (
    <p className={cx("mt-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-[14px] leading-snug", dark ? "border-white/15 bg-white/5 text-slate-200" : "border-brand/20 bg-brand/[0.04] text-ink-2")}>
      <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-lg", dark ? "bg-white/10 text-indigo-100" : "bg-brand-soft text-brand")}><Icon name={icon} size={15} /></span>
      <span className="min-w-0 pt-0.5">
        <b className={dark ? "text-white" : "text-ink"}>{label}.</b> {children}
      </span>
    </p>
  );
}

function FeatureText({ f, dark, points = true, children, className }: { f: Feature; dark?: boolean; points?: boolean; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <Eyebrow icon={f.icon} dark={dark}>{f.eyebrow}</Eyebrow>
      <h2 id={`${f.id}-heading`} className={cx("mt-4 text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.025em] text-balance sm:text-[2.25rem]", dark ? "text-white" : "text-ink")}>
        {f.title}
      </h2>
      <p className={cx("mt-4 text-[16px] leading-relaxed", dark ? "text-slate-300" : "text-ink-2")}>{f.text}</p>
      {points && <Points items={f.points} dark={dark} />}
      {children}
    </div>
  );
}

/** The phone menu: every section, the verify page, and the account links the header has no room for. */
function menuItems(signedIn: boolean): MenuItem[] {
  return [
    { href: "#features", label: NAV.features },
    ...FEATURES.map((f) => ({ href: `#${f.id}`, label: f.eyebrow })),
    { href: "#how-it-works", label: NAV.how },
    { href: "/verify", label: NAV.verify },
    ...(signedIn ? [{ href: "/app", label: NAV.openApp, primary: true }] : [{ href: "/signup", label: NAV.create, primary: true }]),
  ];
}

// Server component; the only client JS is the phone menu. Signed-in visitors see "Open app" instead of the sign-up and sign-in buttons; "/"
// itself never redirects.
export default async function Home() {
  const s = await getSession();
  const primary = s ? (
    <LinkButton href="/app" size="lg" icon="arrowRight">{NAV.openApp}</LinkButton>
  ) : (
    <LinkButton href="/signup" size="lg" className="shadow-[0_8px_24px_-8px_color-mix(in_srgb,var(--brand)_70%,transparent)]">
      {NAV.create}
    </LinkButton>
  );
  return (
    // overflow-x-clip: the preview glows bleed past the edge of narrow phones; clip, don't scroll
    <div className="min-h-screen overflow-x-clip bg-white">
      <header className="sticky top-0 z-40 border-b border-line/70 bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/70">
        <div className={cx(wrap, "flex h-16 items-center justify-between gap-2")}>
          <Link href="/" className="shrink-0 rounded-md" aria-label={`${BRAND.name} home`}>
            <Logo className="text-[17px]" />
          </Link>
          <nav aria-label="Main" className="flex min-w-0 items-center gap-0.5">
            <a href="#features" className={`${navLink} hidden md:inline`}>{NAV.features}</a>
            <a href="#how-it-works" className={`${navLink} hidden md:inline`}>{NAV.how}</a>
            <Link href="/verify" className={`${navLink} hidden lg:inline`}>{NAV.verify}</Link>
            {s ? (
              <LinkButton href="/app" className="ml-1.5" icon="arrowRight">{NAV.openApp}</LinkButton>
            ) : (
              <>
                <Link href="/login" className={navLink}>{NAV.signIn}</Link>
                {/* phones: in the menu instead (and the hero's button is just below) */}
                <span className="ml-1.5 hidden sm:inline-flex"><LinkButton href="/signup">{NAV.create}</LinkButton></span>
              </>
            )}
            <MobileMenu items={menuItems(!!s)} />
          </nav>
        </div>
      </header>

      <main>
        {/* ---------- hero ---------- */}
        <section aria-labelledby="hero-heading" className="relative isolate">
          <div aria-hidden className="lp-hero-bg absolute inset-0 -z-10" />
          <div aria-hidden className="lp-grid absolute inset-x-0 top-0 -z-10 h-[46rem]" />
          <div className={cx(wrap, "pt-14 pb-10 text-center sm:pt-24")}>
            <p className="lp-rise inline-flex items-center gap-2 rounded-full border border-brand/20 bg-white/80 px-3.5 py-1.5 text-[11.5px] font-semibold tracking-[0.16em] text-brand uppercase shadow-1 backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="lp-pulse absolute inset-0 rounded-full bg-brand/50" />
                <span className="relative h-2 w-2 rounded-full bg-brand" />
              </span>
              {HERO.eyebrow}
            </p>
            <h1 id="hero-heading" className="lp-rise lp-d1 mx-auto mt-7 max-w-4xl text-[2.6rem] leading-[1.04] font-semibold tracking-[-0.04em] text-balance text-ink sm:text-6xl lg:text-[4.75rem]">
              <span className="block">{HERO.titleLead}</span> <span className="lp-gradient-text block pb-1">{HERO.titleAccent}</span>
            </h1>
            <p className="lp-rise lp-d2 mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-pretty text-ink-2 sm:text-xl">{HERO.subtitle}</p>
            <div className="lp-rise lp-d3 mt-9 flex flex-wrap items-center justify-center gap-3">
              {primary}
              <LinkButton href="#how-it-works" size="lg" variant="secondary">See how it works</LinkButton>
            </div>
          </div>
          <div className={cx(wrap, "lp-rise lp-d4 relative max-w-5xl pb-6")}>
            <div aria-hidden className="lp-glow pointer-events-none absolute inset-x-0 -top-10 -bottom-10 -z-10 blur-3xl" />
            <HeroStudioPreview />
          </div>
          <div className={cx(wrap, "pt-6 pb-14 sm:pb-16")}>
            <p className="mx-auto flex max-w-fit flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-2xl border border-line bg-white/80 px-5 py-2.5 text-sm text-muted shadow-1 sm:rounded-full">
              <span className="basis-full text-center font-medium text-ink sm:basis-auto">{HERO.workflowLabel}</span>
              {HERO.workflow.map((w, i) => (
                <span key={w} className="inline-flex items-center gap-2.5">
                  {i > 0 && <span aria-hidden className="text-faint">·</span>}
                  <span className="font-medium text-ink-2">{w}</span>
                </span>
              ))}
            </p>
          </div>
        </section>

        {/* ---------- demo video ---------- */}
        <section id={DEMO.id} aria-labelledby="demo-heading" className="scroll-mt-16 border-t border-line bg-subtle/60">
          <div className={cx(wrap, "py-16 sm:py-20")}>
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>{DEMO.eyebrow}</Eyebrow>
              <h2 id="demo-heading" className="mt-4 text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-ink sm:text-[2.6rem]">{DEMO.title}</h2>
              <p className="mx-auto mt-4 max-w-2xl text-[16.5px] leading-relaxed text-ink-2">{DEMO.text}</p>
            </div>
            <div className="mx-auto mt-10 max-w-4xl">
              <DemoVideo />
              <p className="mt-3 text-center text-sm text-muted">
                <a href={`https://youtu.be/${DEMO.videoId}`} target="_blank" rel="noopener noreferrer" className="rounded font-medium text-brand hover:underline">{DEMO.watchOnYouTube}</a>
              </p>
            </div>
          </div>
        </section>

        {/* ---------- features ---------- */}
        <section id="features" aria-labelledby="features-heading" className="scroll-mt-16 border-t border-line bg-white">
          <div className={cx(wrap, "pt-20 pb-4 text-center sm:pt-24")}>
            <Eyebrow>{FEATURES_INTRO.eyebrow}</Eyebrow>
            <h2 id="features-heading" className="mx-auto mt-4 max-w-3xl text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-ink sm:text-5xl">{FEATURES_INTRO.title}</h2>
            <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-2">{FEATURES_INTRO.text}</p>
            <nav aria-label="Features" className="mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-2">
              {FEATURES.map((f) => (
                <a key={f.id} href={`#${f.id}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13.5px] font-medium text-ink-2 shadow-1 transition-colors hover:border-brand/40 hover:text-ink">
                  <Icon name={f.icon} size={15} className="text-brand" />
                  {f.eyebrow}
                </a>
              ))}
            </nav>
          </div>

          {/* Agreement Studio: text left, the draft under review right */}
          <section id={STUDIO.id} aria-labelledby={`${STUDIO.id}-heading`} className={cx(wrap, "grid scroll-mt-16 items-center gap-12 py-16 sm:py-24 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16")}>
            <FeatureText f={STUDIO}>
              <ol aria-label="Agreement Studio steps" className="mt-8 flex flex-wrap gap-2 text-[13px] font-medium text-ink-2">
                {["Describe", "Claude extracts terms", "You review", "Second admin approves", "PDF or DOCX"].map((t, i) => (
                  <li key={t} className="inline-flex items-center gap-2 rounded-full border border-line bg-subtle py-1 pr-3 pl-1">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[11px] font-semibold text-brand ring-1 ring-line">{i + 1}</span>
                    {t}
                  </li>
                ))}
              </ol>
              {VOICE_INPUT && <Callout icon="spark" label={VOICE_INPUT_COPY.label}>{VOICE_INPUT_COPY.text}</Callout>}
            </FeatureText>
            <StudioDraftPreview />
          </section>

          {/* Document Intelligence: a tinted panel, preview left */}
          <div className={wrap}>
            <section id={DOC_INTEL.id} aria-labelledby={`${DOC_INTEL.id}-heading`} className="lp-edge grid scroll-mt-16 items-center gap-12 rounded-[2rem] bg-gradient-to-br from-brand/[0.06] via-bg to-[#7c3aed]/[0.05] px-5 py-12 sm:px-10 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-14">
              <div className="min-w-0 lg:order-2">
                <FeatureText f={DOC_INTEL}>
                  <div className="mt-7 flex flex-wrap gap-2">
                    {DOC_INTEL.chips.map((t) => (
                      <span key={t} className="rounded-lg border border-line bg-white px-2.5 py-1 text-[12.5px] font-medium text-ink-2 shadow-1">{t}</span>
                    ))}
                  </div>
                </FeatureText>
              </div>
              <DocumentPreview />
            </section>
          </div>

          {/* Knowledge Hub + Ask: a two-up bento under a centred heading */}
          <section id={KNOWLEDGE.id} aria-labelledby={`${KNOWLEDGE.id}-heading`} className={cx(wrap, "scroll-mt-16 py-20 sm:py-28")}>
            <div className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <FeatureText f={KNOWLEDGE} />
              <KnowledgePreview />
            </div>
          </section>
        </section>

        {/* ---------- E-signatures: a dark band, three steps side by side ---------- */}
        <section id={SIGN.id} aria-labelledby={`${SIGN.id}-heading`} className="lp-dark relative isolate scroll-mt-16 overflow-hidden bg-ink">
          <div aria-hidden className="lp-grid-dark absolute inset-0 -z-10" />
          <div aria-hidden className="absolute -top-40 left-1/2 -z-10 h-[30rem] w-[60rem] -translate-x-1/2 rounded-full bg-brand/30 blur-[120px]" />
          <div className={cx(wrap, "py-20 sm:py-28")}>
            <div className="grid gap-10 lg:grid-cols-2 lg:items-end">
              <FeatureText f={SIGN} dark points={false} />
              <div className="min-w-0 [&>ul]:mt-0">
                <Points items={SIGN.points} dark />
                <Link href="/verify" className="mt-6 inline-flex items-center gap-1.5 rounded-md text-[15px] font-medium text-white underline-offset-4 hover:underline">
                  Verify a document <Icon name="arrowRight" size={16} />
                </Link>
              </div>
            </div>
            <ol className="mt-16 grid gap-10 md:grid-cols-3 md:gap-6">
              {[
                { title: "Upload and choose", text: "Your PDF or Word agreement, the right one for each client.", preview: <NewFilePreview /> },
                { title: "Client signs", text: "On any device, with consent recorded.", preview: <PhoneSigningPreview /> },
                { title: "Sealed and verifiable", text: "Countersigned, with an audit certificate.", preview: <SealedPreview /> },
              ].map(({ title, text, preview }, i) => (
                <li key={title} className="flex min-w-0 flex-col gap-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-white ring-1 ring-white/20">{i + 1}</span>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-white">{title}</h3>
                      <p className="mt-0.5 text-sm text-slate-300">{text}</p>
                    </div>
                  </div>
                  {preview}
                </li>
              ))}
            </ol>
            {PHONE_SCAN && (
              <div className="mt-10 [&>p]:mx-auto [&>p]:max-w-2xl">
                <Callout icon="upload" label={PHONE_SCAN_COPY.label} dark>{PHONE_SCAN_COPY.text}</Callout>
              </div>
            )}
            <div id="sign-on-phone" className="mt-20 grid items-center gap-12 border-t border-white/10 pt-16 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
              <div className="min-w-0">
                <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12px] font-semibold tracking-[0.08em] text-indigo-100 uppercase">
                  <Icon name="phone" size={14} />
                  {PHONE_SIGN.eyebrow}
                </p>
                <h3 className="mt-4 text-[1.6rem] leading-tight font-semibold tracking-[-0.02em] text-balance text-white sm:text-[2rem]">{PHONE_SIGN.title}</h3>
                <p className="mt-4 text-[16px] leading-relaxed text-slate-300">{PHONE_SIGN.text}</p>
                <Points items={PHONE_SIGN.points} dark />
              </div>
              <PhoneSignPreview />
            </div>
          </div>
        </section>

        {/* ---------- Clause Library: compact, text left ---------- */}
        <section id={CLAUSES.id} aria-labelledby={`${CLAUSES.id}-heading`} className={cx(wrap, "grid scroll-mt-16 items-center gap-12 py-20 sm:py-28 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16")}>
          <FeatureText f={CLAUSES} />
          <ClausePreview />
        </section>

        {/* ---------- how it works ---------- */}
        <section id="how-it-works" aria-labelledby="how-heading" className="scroll-mt-16 border-y border-line bg-bg">
          <div className={cx(wrap, "py-20 sm:py-24")}>
            <div className="text-center">
              <Eyebrow>{HOW.eyebrow}</Eyebrow>
              <h2 id="how-heading" className="mt-4 text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-ink sm:text-[2.5rem]">{HOW.title}</h2>
            </div>
            <ol className="relative mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <span aria-hidden className="absolute top-[2.4rem] right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-brand/10 via-brand/40 to-[#7c3aed]/20 lg:block" />
              {STEPS.map((st, i) => (
                <li key={st.title} className="relative min-w-0 rounded-2xl border border-line bg-white p-5 shadow-1">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand to-[#4f46e5] text-white shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--brand)_80%,transparent)]">
                      <Icon name={st.icon} size={18} />
                    </span>
                    <span className="text-xs font-semibold tracking-[0.1em] text-muted uppercase">Step {i + 1}</span>
                  </div>
                  <h3 className="mt-4 text-[17px] font-semibold text-ink">{st.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{st.text}</p>
                </li>
              ))}
            </ol>
            <p className="mx-auto mt-10 flex max-w-2xl items-start gap-3 rounded-2xl border border-line bg-white px-5 py-4 text-[15px] text-ink-2 shadow-1">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name="upload" size={16} /></span>
              <span className="min-w-0 pt-1">{HOW.note}</span>
            </p>
          </div>
        </section>

        {/* ---------- final call to action ---------- */}
        <section aria-labelledby="cta-heading" className={cx(wrap, "py-16 sm:py-24")}>
          <div className="lp-dark relative isolate overflow-hidden rounded-[2rem] bg-ink px-6 py-16 text-center sm:px-12 sm:py-20">
            <div aria-hidden className="lp-grid-dark absolute inset-0 -z-10" />
            <div aria-hidden className="absolute -bottom-40 left-1/2 -z-10 h-80 w-[44rem] -translate-x-1/2 rounded-full bg-brand/45 blur-[100px]" />
            <div aria-hidden className="absolute -top-32 right-0 -z-10 h-64 w-96 rounded-full bg-[#7c3aed]/25 blur-[90px]" />
            <h2 id="cta-heading" className="mx-auto max-w-2xl text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-white sm:text-5xl">{CTA.title}</h2>
            <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-slate-300">{CTA.text}</p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              {s ? (
                <LinkButton href="/app" size="lg" variant="secondary" icon="arrowRight">{NAV.openApp}</LinkButton>
              ) : (
                <LinkButton href="/signup" size="lg" variant="secondary">{NAV.create}</LinkButton>
              )}
              <Link href="/verify" className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-white/20 px-5 text-[15px] font-medium text-white transition-colors hover:bg-white/10">
                <Icon name="shield" size={16} />
                Verify a document
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-bg">
        <div className={cx(wrap, "grid gap-8 py-12 md:grid-cols-[1.4fr_1fr]")}>
          <div className="min-w-0">
            <Logo />
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">{FOOTER.about}</p>
          </div>
          <nav aria-label="Footer" className="flex flex-col gap-2.5 text-sm text-ink-2 md:items-end">
            <Link href="/verify" className="w-fit rounded hover:text-ink">Verify a document</Link>
            <Link href="/login" className="w-fit rounded hover:text-ink">{NAV.signIn}</Link>
            <Link href="/signup" className="w-fit rounded hover:text-ink">{NAV.create}</Link>
          </nav>
        </div>
        <div className="border-t border-line">
          <p className={cx(wrap, "py-6 text-xs text-muted")}>{FOOTER.note}</p>
        </div>
      </footer>
    </div>
  );
}
