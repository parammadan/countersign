import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { LinkButton, Logo } from "@/components/ui";
import { Icon } from "@/components/icons";
import { BRAND } from "@/lib/brand";
import { EXPLORE, FEATURES, FOOTER_NOTE, HERO, STEPS } from "@/components/landing/copy";
import { FEATURE_PREVIEWS, JourneyPreview } from "@/components/landing/Previews";

export const metadata: Metadata = {
  title: { absolute: `${BRAND.name}: ${HERO.eyebrow}` },
  description: HERO.subtitle,
};

const navLink = "rounded-md px-3 py-2 text-muted hover:text-ink";

// Server component, no client JS. Signed-in visitors see "Open app" instead of the sign-up and sign-in buttons; "/"
// itself never redirects.
export default async function Home() {
  const s = await getSession();
  return (
    // overflow-x-clip: the preview glows bleed past the edge of narrow phones; clip, don't scroll
    <div className="min-h-screen overflow-x-clip bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-5 sm:px-6">
        <Link href="/" className="rounded-md" aria-label={`${BRAND.name} home`}>
          <Logo className="text-lg" />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          <a href="#features" className={`${navLink} hidden md:inline`}>Features</a>
          <a href="#how-it-works" className={`${navLink} hidden md:inline`}>How it works</a>
          <Link href="/verify" className={`${navLink} hidden sm:inline`}>Verify a document</Link>
          {s ? (
            <LinkButton href="/app" className="ml-1">Open app</LinkButton>
          ) : (
            <>
              <Link href="/login" className={navLink}>Sign in</Link>
              <LinkButton href="/signup" className="ml-1">Get started</LinkButton>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 pt-12 pb-16 sm:px-6 sm:pt-20 lg:grid-cols-[1.15fr_1fr]">
          <div className="min-w-0">
            <p className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold tracking-wide text-brand uppercase">
              <Icon name="spark" size={16} />
              {HERO.eyebrow}
            </p>
            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">{HERO.title}</h1>
            <p className="mt-6 max-w-2xl text-lg text-ink-2">{HERO.subtitle}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              {s ? (
                <LinkButton href="/app" size="lg" icon="arrowRight">Open app</LinkButton>
              ) : (
                <>
                  <LinkButton href="/signup" size="lg">Get started</LinkButton>
                  <LinkButton href="/login" size="lg" variant="secondary">Sign in</LinkButton>
                </>
              )}
            </div>
          </div>
          <JourneyPreview />
        </section>

        <section id="how-it-works" aria-labelledby="how-heading" className="scroll-mt-4 border-y border-line bg-bg">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-heading" className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">How it works</h2>
            <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((st, i) => (
                <li key={st.title} className="relative min-w-0">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">{i + 1}</span>
                    {i < STEPS.length - 1 && <span aria-hidden className="hidden h-px flex-1 bg-line-strong lg:block" />}
                  </div>
                  <h3 className="font-semibold text-ink">{st.title}</h3>
                  <p className="mt-1.5 text-sm text-muted">{st.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <div id="features" className="scroll-mt-4">
          {FEATURES.map((f, i) => {
            const Preview = FEATURE_PREVIEWS[f.id];
            return (
              <section key={f.id} id={f.id} aria-labelledby={`${f.id}-heading`} className={i % 2 ? "bg-bg" : "bg-white"}>
                <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-16">
                  <div className={`min-w-0 ${i % 2 ? "lg:order-2" : ""}`}>
                    <p className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
                      <Icon name={f.icon} size={16} />
                      {f.eyebrow}
                    </p>
                    <h2 id={`${f.id}-heading`} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{f.title}</h2>
                    <p className="mt-4 text-ink-2">{f.text}</p>
                    <ul className="mt-5 space-y-2.5">
                      {f.points.map((p) => (
                        <li key={p} className="flex gap-2.5 text-sm text-ink-2">
                          <Icon name="check" size={16} className="mt-0.5 shrink-0 text-brand" />
                          <span className="min-w-0">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className={`min-w-0 ${i % 2 ? "lg:order-1" : ""}`}>
                    <Preview />
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        <section aria-labelledby="explore-heading" className="border-t border-line">
          <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6">
            <h2 id="explore-heading" className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{EXPLORE.title}</h2>
            <p className="mt-4 text-ink-2">{EXPLORE.text}</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              {s ? (
                <LinkButton href="/app" size="lg" icon="arrowRight">Open app</LinkButton>
              ) : (
                <LinkButton href="/signup" size="lg">{EXPLORE.cta}</LinkButton>
              )}
              <LinkButton href="/verify" size="lg" variant="secondary" icon="shield">Verify a document</LinkButton>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-bg">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:px-6 md:flex-row md:items-center md:justify-between">
          <Logo />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-muted">
            <Link href="/login" className="rounded hover:text-ink">Sign in</Link>
            <Link href="/signup" className="rounded hover:text-ink">Get started</Link>
            <Link href="/verify" className="rounded hover:text-ink">Verify a document</Link>
          </nav>
        </div>
        <p className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted sm:px-6">{FOOTER_NOTE}</p>
      </footer>
    </div>
  );
}
