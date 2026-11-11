// Static, illustrative mock-ups of real screens for the landing page. Server-rendered markup only (no client JS, no
// images), styled with the app's own tokens and primitives. Sample names are fictional. The mock content is hidden
// from assistive tech (it has no real controls); each frame carries a visible "Illustrative" caption and a
// screen-reader description of what it shows.
import type { ReactNode } from "react";
import { Badge, LogoMark, cx } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { AI_COPY } from "@/components/studio/ai-state";
import { DOC_INTEL, DOC_INTEL_AI, HERO, PREVIEW_LABEL, SAMPLE } from "./copy";

/** A labelled figure: the decorative mock-up, then a visible caption that says it's illustrative. */
export function Preview({ describe, caption = PREVIEW_LABEL, children, className, glow = true, dark }: { describe: string; caption?: string; children: ReactNode; className?: string; glow?: boolean; dark?: boolean }) {
  return (
    <figure className={cx("relative min-w-0", className)}>
      {glow && <div aria-hidden className="lp-glow pointer-events-none absolute -inset-6 -z-10 rounded-[2.5rem] opacity-80 blur-2xl" />}
      <div aria-hidden className="relative">{children}</div>
      <figcaption className={cx("mt-3 flex items-center justify-center gap-1.5 text-xs", dark ? "text-slate-300" : "text-muted")}>
        <Icon name="info" size={13} />
        {caption}
        <span className="sr-only">: {describe}</span>
      </figcaption>
    </figure>
  );
}

/** An app window: a title bar with the screen's name, then its content. */
export function Window({ title, children, className, right }: { title: string; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <div className={cx("lp-window overflow-hidden rounded-2xl border border-line bg-white", className)}>
      <div className="flex h-10 items-center gap-3 border-b border-line bg-subtle/90 px-4">
        <span className="flex shrink-0 gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#e5e7eb]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e5e7eb]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#e5e7eb]" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium text-muted">
          <LogoMark size={14} />
          <span className="truncate">{title}</span>
        </span>
        {right}
      </div>
      {children}
    </div>
  );
}

/** Looks like a button; it's a span, because the preview has no real controls. */
function FakeButton({ children, icon, variant = "primary", className }: { children: ReactNode; icon?: IconName; variant?: "primary" | "secondary"; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap",
        variant === "primary" ? "bg-brand text-white shadow-1" : "border border-line-strong bg-white text-ink shadow-1",
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

const SUGGESTED = "Suggested by Claude: check it";

function MockField({ label, value, suggested = true, className }: { label: string; value: string; suggested?: boolean; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-2">
        {label}
        {suggested && <Badge tone="warn" icon="spark" className="text-[11px]">{SUGGESTED}</Badge>}
      </div>
      <div className="truncate rounded-lg border border-line-strong bg-white px-2.5 py-1.5 text-[13px] text-ink shadow-1">{value}</div>
    </div>
  );
}

/** Hero: Agreement Studio's "Create an agreement with AI" panel, after Claude has suggested the details. */
export function HeroStudioPreview() {
  return (
    <Preview
      caption={HERO.caption}
      glow={false}
      describe="Agreement Studio's “Create an agreement with AI” panel: a plain-English description of a consulting agreement between Northwind Advisory LLC and Acme Widgets Inc, and the agreement details it was turned into, each marked “Suggested by Claude: check it”."
    >
      <div className="relative">
        <Window title="Agreement Studio · New agreement" right={<Badge tone="ok" icon="spark" className="hidden sm:inline-flex">AI on</Badge>}>
          <div className="grid md:grid-cols-[1fr_1.1fr]">
            <div className="border-b border-line p-4 sm:p-5 md:border-r md:border-b-0">
              <div className="rounded-xl border border-brand/25 bg-brand/[0.04] p-4">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <span className="relative grid h-6 w-6 place-items-center rounded-md bg-brand text-white">
                    <Icon name="spark" size={14} />
                    <span className="lp-pulse absolute -inset-1 -z-10 rounded-lg bg-brand/30 blur-[6px]" />
                  </span>
                  {AI_COPY.heading}
                </div>
                <div className="mt-3 mb-1.5 text-[13px] font-medium text-ink-2">{AI_COPY.inputLabel}</div>
                <div className="rounded-lg border border-brand/40 bg-white px-3 py-2.5 text-[13px] leading-relaxed text-ink shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_12%,transparent)]">
                  {SAMPLE.description}
                  <span className="lp-caret ml-0.5 inline-block h-3.5 w-px translate-y-0.5 bg-brand" />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <FakeButton icon="spark">{AI_COPY.button}</FakeButton>
                  <FakeButton variant="secondary">{AI_COPY.exampleButton}</FakeButton>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">{AI_COPY.hint}</p>
              </div>
              <p className="mt-4 hidden text-xs leading-relaxed text-muted md:block">{AI_COPY.footnote}</p>
            </div>
            <div className="p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[15px] font-semibold text-ink">Agreement details</div>
                <span className="text-xs text-muted">Reviewed template</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MockField label="Type of agreement" value="Consulting Agreement" className="sm:col-span-2" />
                <MockField label="Consultant (legal name)" value={SAMPLE.consultant} />
                <MockField label="Client (legal name)" value={SAMPLE.client} />
                <MockField label="Fee" value="$12,000" />
                <MockField label="How the fee is charged" value="a one-time fixed fee" className="hidden sm:block" />
                <MockField label="Governing law" value="Delaware" className="sm:col-span-2" />
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-xs text-muted">
                <Icon name="shield" size={14} className="shrink-0 text-brand" />
                You review and approve everything before it&apos;s published.
              </div>
            </div>
          </div>
        </Window>
        <div className="lp-float absolute bottom-7 -left-10 hidden items-center gap-2 rounded-xl border border-line bg-white/95 px-3 py-2 text-xs font-medium text-ink shadow-3 backdrop-blur xl:flex">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-ok-bg text-ok"><Icon name="checkCircle" size={14} /></span>
          Fills a reviewed template
        </div>
        <div className="lp-float lp-float-late absolute -top-5 right-28 hidden items-center gap-2 rounded-xl border border-line bg-white/95 px-3 py-2 text-xs font-medium text-ink shadow-3 backdrop-blur xl:flex">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-brand"><Icon name="shield" size={14} /></span>
          Second-admin approval
        </div>
      </div>
    </Preview>
  );
}

function Mark({ children }: { children: ReactNode }) {
  return <span className="rounded bg-warn-bg px-1 font-medium text-ink ring-1 ring-amber-200/80 ring-inset">{children}</span>;
}

/** Agreement Studio: the generated draft, waiting for a second admin, with the export options. */
export function StudioDraftPreview() {
  return (
    <Preview describe="a generated consulting agreement draft with the filled-in values highlighted, an approval panel waiting for a second admin, and PDF and DOCX export buttons.">
      <Window title="Agreement Studio · Draft v1">
        <div className="grid sm:grid-cols-[1.75fr_1fr]">
          <div className="bg-bg p-4 sm:p-5">
            <div className="rounded-lg border border-line bg-white px-4 py-5 font-serif text-[12.5px] leading-relaxed text-ink-2 shadow-1 sm:px-5">
              <div className="text-center text-[13px] font-semibold tracking-[0.12em] text-ink">CONSULTING AGREEMENT</div>
              <p className="mt-3">
                This Consulting Agreement is between <Mark>{SAMPLE.consultant}</Mark> (&ldquo;Consultant&rdquo;) and <Mark>{SAMPLE.client}</Mark> (&ldquo;Client&rdquo;).
              </p>
              <p className="mt-2"><b className="text-ink">3. Fees.</b> Client shall pay Consultant <Mark>a one-time fixed fee</Mark> of <Mark>$12,000</Mark>.</p>
              <p className="mt-2"><b className="text-ink">12. Governing law.</b> This Agreement is governed by the laws of <Mark>Delaware</Mark>.</p>
              <div className="mt-3 space-y-1.5" >
                <div className="h-1.5 w-full rounded bg-line" />
                <div className="h-1.5 w-11/12 rounded bg-line" />
                <div className="h-1.5 w-4/5 rounded bg-line" />
              </div>
            </div>
          </div>
          <div className="space-y-3 border-t border-line p-4 sm:border-t-0 sm:border-l sm:p-5">
            <div>
              <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Approval</div>
              <div className="mt-2 rounded-lg border border-line p-3">
                <Badge tone="warn" icon="clock">Waiting for a second admin</Badge>
                <div className="mt-2 text-xs text-muted">Submitted by Avery Tester</div>
                <div className="mt-2.5 flex gap-2">
                  <FakeButton icon="check" className="h-7 text-xs">Approve</FakeButton>
                  <FakeButton variant="secondary" className="h-7 text-xs">Request changes</FakeButton>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">Export</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <FakeButton variant="secondary" icon="agreement" className="h-7 text-xs">PDF</FakeButton>
                <FakeButton variant="secondary" icon="agreement" className="h-7 text-xs">DOCX</FakeButton>
              </div>
            </div>
          </div>
        </div>
      </Window>
    </Preview>
  );
}

function ReadRow({ label, value, page, quote, tone }: { label: string; value: string; page?: number; quote?: string; tone?: "warn" | "bad" }) {
  return (
    <li className={cx("px-4 py-2.5", tone === "warn" && "bg-warn-bg/70")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-xs text-muted">{label}</span>
        <span className="min-w-0 truncate text-right text-[13px] font-medium text-ink">{value}</span>
      </div>
      {quote && (
        <div className="mt-0.5 truncate text-[11.5px] text-muted">
          p. {page}: &ldquo;{quote}&rdquo;
        </div>
      )}
    </li>
  );
}

function DocHeader({ sub, badge }: { sub: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name="agreement" size={18} /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink">northwind-acme-consulting.pdf</div>
        <div className="truncate text-xs text-muted">{sub}</div>
      </div>
      {badge}
    </div>
  );
}

const sectionLabel = "text-[11px] font-semibold tracking-wide text-muted uppercase";

/** Document Intelligence with AI: the plain-English summary, quoted key terms, a chat turn and the Studio handoff. */
function DocumentAiPreview() {
  return (
    <Preview describe="Document Intelligence's AI analysis of an uploaded consulting agreement: a plain-English summary with its source page, key terms each quoted with their page, a chat question about this document answered with a quoted passage, and a button to start an Agreement Studio draft. Marked informational, not legal advice.">
      <Window title="Document Intelligence" right={<Badge tone="ok" icon="spark" className="hidden sm:inline-flex">AI on</Badge>}>
        <DocHeader sub="Consulting agreement · 4 pages · analyzed by Claude" badge={<Badge tone="neutral" className="hidden text-[11px] sm:inline-flex">{DOC_INTEL.badge}</Badge>} />
        <div className="border-b border-line bg-brand/[0.035] px-4 py-3">
          <div className={cx(sectionLabel, "flex items-center gap-1.5 text-brand")}><Icon name="spark" size={12} />In plain English</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink">Northwind Advisory LLC will provide consulting services to Acme Widgets Inc for a one-time fixed fee of $12,000, under Delaware law.</p>
          <div className="mt-1 text-[11.5px] text-brand">Source: page 1, 2</div>
        </div>
        <div className="px-4 pt-3">
          <div className={sectionLabel}>Key terms</div>
        </div>
        <ul className="divide-y divide-line">
          <ReadRow label="Fee" value="$12,000, one-time" page={2} quote="a one-time fixed fee of $12,000" />
          <ReadRow label="Termination" value="30 days' notice" page={3} quote="either party may terminate on thirty (30) days' notice" />
          <ReadRow label="Governing law" value="Delaware" page={4} quote="governed by the laws of Delaware" />
        </ul>
        <div className="space-y-2 border-t border-line bg-subtle/70 px-4 py-3">
          <div className={sectionLabel}>Chat with this document</div>
          <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-1.5 text-[12.5px] text-white">Can either party terminate early?</div>
          <div className="rounded-xl border border-line bg-white px-3 py-2 text-[12.5px] text-ink">
            Yes. Either party can end it with 30 days&apos; notice.
            <span className="mt-1 block truncate text-[11px] text-muted">p. 3: &ldquo;either party may terminate on thirty (30) days&apos; notice&rdquo;</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <FakeButton icon="agreement" variant="secondary">Start a draft in Agreement Studio</FakeButton>
          <span className="text-[11px] text-muted sm:hidden">{DOC_INTEL.badge}</span>
        </div>
      </Window>
    </Preview>
  );
}

/** Document Intelligence by rules: what was read, with sources, a conflict and quarantined text. */
function DocumentRulesPreview() {
  return (
    <Preview describe={`Document Intelligence's reading of an uploaded consulting agreement: parties, fee and governing law, each with its page and quoted passage; a flagged conflict; one quarantined line of text; and a button to start a draft. Badge: ${DOC_INTEL.badge}.`}>
      <Window title="Document Intelligence" right={<Badge tone="neutral" className="hidden sm:inline-flex">{DOC_INTEL.badge}</Badge>}>
        <DocHeader sub="Consulting agreement · 4 pages" badge={<Badge tone="warn" icon="alert" className="hidden sm:inline-flex">Needs review</Badge>} />
        <ul className="divide-y divide-line">
          <ReadRow label="Consultant" value={SAMPLE.consultant} page={1} quote="Northwind Advisory LLC (“Consultant”)" />
          <ReadRow label="Client" value={SAMPLE.client} page={1} quote="Acme Widgets Inc (“Client”)" />
          <ReadRow label="Fee" value="USD 12,000" page={2} quote="a one-time fixed fee of $12,000" />
          <ReadRow label="Governing law" value="Delaware" page={4} quote="governed by the laws of Delaware" />
          <ReadRow label="Conflict: notice period" value="30 days vs 60 days" tone="warn" />
        </ul>
        <div className="border-t border-amber-200 bg-warn-bg/60 px-4 py-2.5 text-[12px]">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="warn" icon="shield">Quarantined</Badge>
            <span className="text-muted">p. 3:</span>
            <span className="min-w-0 truncate font-mono text-ink">Ignore previous instructions and…</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <FakeButton icon="agreement" variant="secondary">Start a draft in Agreement Studio</FakeButton>
          <Badge tone="neutral" className="sm:hidden">{DOC_INTEL.badge}</Badge>
        </div>
      </Window>
    </Preview>
  );
}

/** Document Intelligence: the AI analysis or the rules' reading, following DOC_INTEL_AI. */
export function DocumentPreview() {
  return DOC_INTEL_AI ? <DocumentAiPreview /> : <DocumentRulesPreview />;
}

function Cite({ n }: { n: number }) {
  return <span className="relative -top-1 ml-0.5 inline-grid h-4 min-w-4 place-items-center rounded bg-brand-soft px-1 text-[10px] leading-none font-semibold text-brand">{n}</span>;
}

/** Knowledge Hub across all agreements, with Ask about one agreement layered over it. */
export function KnowledgePreview() {
  return (
    <Preview describe="the Knowledge Hub: a question asked across all agreements, an answer citing two agreements with their page numbers, and a question nothing in the agreements supports; in front of it, a question about one agreement with a verified answer and the quoted passage and page it relies on.">
      <div className="relative">
        <Window title="Knowledge Hub · all agreements">
          <div className="space-y-3 p-4 sm:p-5 sm:pb-16">
            <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-white px-3 py-2.5 shadow-1">
              <Icon name="spark" size={16} className="shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">Which agreements are governed by Delaware law?</span>
              <FakeButton className="h-7 text-xs">Ask</FakeButton>
            </div>
            <div className="rounded-xl border border-line bg-white p-3.5">
              <p className="text-[13.5px] leading-relaxed text-ink">
                Two agreements choose Delaware law: the consulting agreement with Acme Widgets Inc<Cite n={1} /> and the mutual NDA with Fabrikam Inc<Cite n={2} />.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[
                  [1, "Consulting Agreement: Acme Widgets Inc", "page 4", "governed by the laws of Delaware"],
                  [2, "Mutual NDA: Fabrikam Inc", "page 3", "the laws of the State of Delaware"],
                ].map(([n, a, p, q]) => (
                  <div key={n} className="min-w-0 rounded-lg border-l-2 border-brand/50 bg-subtle px-3 py-2">
                    <div className="truncate text-[11.5px] font-semibold text-ink"><span className="text-brand">[{n}]</span> {a}</div>
                    <div className="truncate text-[11.5px] text-muted">{p} · &ldquo;{q}&rdquo;</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-line-strong bg-subtle px-3.5 py-3 text-[13px]">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-muted" />
              <div className="min-w-0">
                <div className="truncate font-medium text-ink">Do any agreements include a non-compete?</div>
                <div className="text-muted">Nothing in your agreements supports an answer, so nothing is quoted.</div>
              </div>
            </div>
          </div>
        </Window>
        <div className="relative z-10 mt-5 sm:-mt-10 sm:ml-auto sm:w-[78%] lg:-mr-6">
          <Window title="Ask about this agreement">
            <div className="space-y-3 p-4">
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-[13px] text-white">When are invoices due?</div>
              <div className="rounded-xl border border-line bg-white p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="ok" icon="checkCircle">Verified</Badge>
                  <span className="text-xs text-muted">checked against the agreement</span>
                </div>
                <p className="mt-2 text-[13.5px] text-ink">Invoices are due within 30 days of the invoice date.</p>
                <blockquote className="mt-2.5 border-l-2 border-brand/50 bg-subtle py-1.5 pr-2 pl-3 text-[12.5px] text-ink-2">
                  &ldquo;Client shall pay each invoice within thirty (30) days of the invoice date.&rdquo;
                  <div className="mt-1 text-[11px] text-muted">Section 4.2 · page 2</div>
                </blockquote>
              </div>
            </div>
          </Window>
        </div>
      </div>
    </Preview>
  );
}

/** E-signatures, step 1: a new file, with the agreement chosen for this client. */
export function NewFilePreview() {
  return (
    <Preview dark glow={false} describe="a new file for client Jordan Sample, with the uploaded Consulting Agreement version 3 chosen as the agreement to send.">
      <Window title="New file">
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-brand/[0.04] px-3 py-2.5 text-[12.5px] text-ink-2">
            <Icon name="upload" size={16} className="shrink-0 text-brand" />
            <span className="min-w-0 truncate">consulting-agreement.docx uploaded</span>
          </div>
          {[["Client", "Jordan Sample"], ["Email", "jordan@example.com"]].map(([l, v]) => (
            <div key={l}>
              <div className="mb-1 text-xs font-medium text-ink-2">{l}</div>
              <div className="truncate rounded-lg border border-line-strong px-2.5 py-1.5 text-[13px] text-ink">{v}</div>
            </div>
          ))}
          <div>
            <div className="mb-1 text-xs font-medium text-ink-2">Agreement to send</div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-brand/50 px-2.5 py-1.5 text-[13px] text-ink ring-2 ring-brand/10">
              <span className="truncate">Consulting Agreement · v3</span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-muted" />
            </div>
          </div>
          <FakeButton icon="send" className="w-full justify-center">Send for signature</FakeButton>
        </div>
      </Window>
    </Preview>
  );
}

/** E-signatures, step 2: the client's signing room on a phone. */
export function PhoneSigningPreview() {
  return (
    <Preview dark glow={false} describe="the client's signing screen on a phone: the agreement's signature block, an electronic-signature consent checkbox and a “Review and sign” button.">
      <div className="mx-auto w-[248px] rounded-[2.4rem] border border-white/15 bg-[#0b1020] p-2.5 shadow-[0_30px_80px_-20px_rgba(31,79,209,.55)]">
        <div className="overflow-hidden rounded-[1.9rem] bg-white">
          <div className="flex justify-center pt-2"><span className="h-1.5 w-16 rounded-full bg-[#e5e7eb]" /></div>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[11px] text-muted">{SAMPLE.consultant}</div>
              <div className="truncate text-[13px] font-semibold text-ink">Consulting Agreement</div>
            </div>
            <span className="shrink-0 text-[11px] text-muted">3 of 3</span>
          </div>
          <div className="space-y-3.5 px-4 py-4">
            <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-dashed border-line-strong bg-subtle p-2.5">
              {[["CONSULTANT", "Avery Tester"], ["CLIENT", "Jordan Sample"]].map(([h, n]) => (
                <div key={h} className="min-w-0">
                  <div className="truncate text-[9px] font-semibold tracking-wide text-muted">{h}</div>
                  <div className="mt-1 truncate border-b border-gray-400 pb-0.5 font-[cursive] text-[13px] text-brand italic">{n}</div>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2 text-[12px] leading-snug text-ink-2">
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded bg-brand text-white"><Icon name="check" size={11} /></span>
              I agree to use electronic records and signatures for this agreement.
            </div>
            <span className="flex h-10 items-center justify-center rounded-[10px] bg-brand text-sm font-medium text-white">Review and sign</span>
            <div className="flex items-center justify-center gap-1.5 pb-1 text-[11px] text-muted">
              <Icon name="shield" size={13} />
              No account or download needed
            </div>
          </div>
        </div>
      </div>
    </Preview>
  );
}

/** E-signatures, step 3: the sealed copy, and what the public verify page says about it. */
export function SealedPreview() {
  const steps = ["Signed by Jordan Sample", "Countersigned automatically", "Audit certificate attached"];
  return (
    <Preview dark glow={false} describe="a completed file: signed by the client, countersigned automatically, with the audit certificate attached, and the public verify page reporting the sealed PDF as authentic.">
      <Window title="Files · Acme Widgets Inc" right={<Badge tone="ok" icon="checkCircle" className="hidden sm:inline-flex">Completed</Badge>}>
        <div className="space-y-3 p-4">
          <ol className="space-y-2">
            {steps.map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-bg text-ok"><Icon name="check" size={12} /></span>
                {t}
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <Icon name="agreement" size={16} className="shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">consulting-agreement-signed.pdf</span>
            <span className="text-[11px] text-muted">Sealed</span>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-ok-bg px-3 py-2.5 text-[12.5px] text-emerald-950">
            <div className="flex items-center gap-1.5 font-semibold"><Icon name="shield" size={14} className="text-ok" />Verify page: Authentic.</div>
            <div className="mt-0.5 leading-snug">Sealed by AgreementOS for {SAMPLE.consultant}.</div>
            <div className="mt-1 truncate font-mono text-[10.5px] opacity-75">sha256 3f9a0c…e1c21e</div>
          </div>
        </div>
      </Window>
    </Preview>
  );
}

/** A decorative, non-scannable QR-like pattern: three finder squares and fixed pseudo-random modules. */
function FakeQr({ size = 112 }: { size?: number }) {
  const n = 21;
  const finder = (x: number, y: number) => x < 8 && y < 8;
  const inFinder = (x: number, y: number) => finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!inFinder(x, y) && ((x * 7 + y * 13 + x * y * 3) % 5 < 2)) d += `M${x} ${y}h1v1h-1z`;
  const box = (x: number, y: number) => `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  return (
    <svg width={size} height={size} viewBox={`-1 -1 ${n + 2} ${n + 2}`} className="rounded-md bg-white" shapeRendering="crispEdges">
      <path d={box(0, 0) + box(n - 7, 0) + box(0, n - 7)} fill="var(--ink)" fillRule="evenodd" />
      <path d={d} fill="var(--ink)" />
    </svg>
  );
}

/** "Sign on your phone": the signing page on a computer shows a QR code; the client signs on the phone. */
export function PhoneSignPreview() {
  return (
    <Preview dark glow={false} describe="the client's signing page on a computer with the “Sign on your phone” dialog open, showing a QR code of the same signing link and a Copy link button, and next to it the phone that opened it, with a “Review and sign” button.">
      <div className="relative pb-4 sm:pr-24">
        <Window title="Consulting Agreement · Northwind Advisory LLC">
          <div className="relative bg-bg px-4 py-5 sm:px-6">
            <div className="space-y-2 rounded-lg border border-line bg-white p-4 opacity-60">
              <div className="h-2 w-1/3 rounded bg-line-strong" />
              <div className="h-1.5 w-full rounded bg-line" />
              <div className="h-1.5 w-11/12 rounded bg-line" />
              <div className="h-1.5 w-4/5 rounded bg-line" />
              <div className="h-1.5 w-full rounded bg-line" />
              <div className="h-1.5 w-2/3 rounded bg-line" />
            </div>
            <div className="absolute inset-0 grid place-items-center bg-ink/25 p-4">
              <div className="w-full max-w-[300px] rounded-xl border border-line bg-white p-4 text-center shadow-3">
                <div className="text-[14px] font-semibold text-ink">Sign on your phone</div>
                <div className="mt-3 flex justify-center"><FakeQr /></div>
                <p className="mt-3 text-[11.5px] leading-snug text-ink-2">Scan with your phone&apos;s camera. You&apos;ll sign there; this page updates when you&apos;re done.</p>
                <div className="mt-3 flex justify-center"><FakeButton variant="secondary" icon="copy" className="h-7 text-xs">Copy link</FakeButton></div>
              </div>
            </div>
          </div>
        </Window>
        <div className="absolute right-0 bottom-0 hidden w-[150px] rounded-[1.8rem] border border-white/15 bg-[#0b1020] p-1.5 shadow-[0_24px_60px_-16px_rgba(31,79,209,.6)] sm:block">
          <div className="overflow-hidden rounded-[1.45rem] bg-white">
            <div className="flex justify-center pt-1.5"><span className="h-1 w-10 rounded-full bg-[#e5e7eb]" /></div>
            <div className="border-b border-line px-3 py-2">
              <div className="truncate text-[9px] text-muted">{SAMPLE.consultant}</div>
              <div className="truncate text-[11px] font-semibold text-ink">Consulting Agreement</div>
            </div>
            <div className="space-y-2 px-3 py-3">
              <div className="rounded-lg border border-dashed border-line-strong bg-subtle px-2 py-1.5">
                <div className="text-[7.5px] font-semibold tracking-wide text-muted">CLIENT</div>
                <div className="truncate border-b border-gray-400 font-[cursive] text-[12px] text-brand italic">Jordan Sample</div>
              </div>
              <span className="flex h-7 items-center justify-center rounded-md bg-brand text-[10.5px] font-medium text-white">Review and sign</span>
              <div className="flex items-center justify-center gap-1 pb-0.5 text-[8.5px] text-muted"><Icon name="shield" size={10} />Same signing link</div>
            </div>
          </div>
        </div>
      </div>
    </Preview>
  );
}

/** Clause Library: one clause, its placeholder and its version history. */
export function ClausePreview() {
  const versions: { v: string; tone: "ok" | "bad" | "warn"; state: string; who: string }[] = [
    { v: "v3", tone: "warn", state: "In review", who: "Submitted by Avery Tester" },
    { v: "v2", tone: "ok", state: "Approved", who: "Approved by Riley Example" },
    { v: "v1", tone: "bad", state: "Retired", who: "Replaced by v2" },
  ];
  return (
    <Preview describe="a clause in the Clause Library, with a placeholder in its text and three versions: in review, approved by a second admin, and retired.">
      <Window title="Clause Library · Limitation of liability">
        <div className="grid sm:grid-cols-[1.2fr_1fr]">
          <div className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">Limitation of liability</span>
              <Badge tone="ok" icon="checkCircle">Approved text in use</Badge>
            </div>
            <p className="mt-3 rounded-lg border border-line bg-subtle px-3 py-2.5 font-serif text-[13px] leading-relaxed text-ink-2">
              Neither party&apos;s total liability under this Agreement will exceed{" "}
              <span className="rounded bg-brand-soft px-1 font-mono text-[12px] text-brand">{"{{liability_cap}}"}</span>, except for amounts owed under the Fees section.
            </p>
          </div>
          <ol className="space-y-2.5 border-t border-line p-4 sm:border-t-0 sm:border-l sm:p-5">
            {versions.map((x) => (
              <li key={x.v} className="flex items-center gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-white text-[11px] font-semibold text-ink">{x.v}</span>
                <div className="min-w-0 flex-1">
                  <Badge tone={x.tone}>{x.state}</Badge>
                  <div className="mt-0.5 truncate text-[11.5px] text-muted">{x.who}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Window>
    </Preview>
  );
}
