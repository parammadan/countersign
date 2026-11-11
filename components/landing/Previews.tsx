// Static, illustrative mock-ups of real screens for the landing page. Server-rendered markup only (no client JS, no
// images), styled with the app's own tokens and primitives. Sample names are fictional. The mock content is hidden
// from assistive tech (it has no real controls); each frame carries a visible "Illustrative preview" caption and a
// screen-reader description of what it shows.
import type { ReactNode } from "react";
import { Badge, cx } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { PREVIEW_LABEL } from "./copy";

export function PreviewFrame({ describe, children, className }: { describe: string; children: ReactNode; className?: string }) {
  return (
    <figure className={cx("relative mx-auto w-full max-w-md min-w-0", className)}>
      <div aria-hidden className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-brand/12 via-brand/4 to-transparent blur-2xl" />
      <div aria-hidden className="overflow-hidden rounded-2xl border border-line bg-white shadow-2">
        {children}
      </div>
      <figcaption className="mt-2 text-center text-xs text-muted">
        {PREVIEW_LABEL}
        <span className="sr-only">: {describe}</span>
      </figcaption>
    </figure>
  );
}

/** Looks like a button; it's a span, because the preview has no real controls. */
function FakeButton({ children, icon, variant = "primary" }: { children: ReactNode; icon?: IconName; variant?: "primary" | "secondary" }) {
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap",
        variant === "primary" ? "bg-brand text-white" : "border border-line-strong bg-white text-ink",
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

function PanelHeader({ title, sub, badge }: { title: string; sub?: string; badge?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink">{title}</div>
        {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      </div>
      {badge}
    </div>
  );
}

/** Hero: one file's journey, from a description to a sealed copy. */
export function JourneyPreview() {
  const rows: [string, string][] = [
    ["Drafted from a description with Claude", "Mon"],
    ["Approved by a second admin", "Mon"],
    ["Sent to Jordan Sample, Acme Widgets Inc", "Tue 9:02"],
    ["Opened and signed on a phone", "Tue 9:44"],
    ["Countersigned automatically", "Tue 9:44"],
    ["Sealed PDF and audit certificate filed", "Tue 9:44"],
  ];
  return (
    <PreviewFrame describe="a file's timeline, from an AI-drafted consulting agreement to a countersigned, sealed copy.">
      <PanelHeader title="Consulting Agreement: Acme Widgets Inc" sub="Northwind Advisory LLC · version 3" badge={<Badge tone="ok" icon="checkCircle">Completed</Badge>} />
      <ol className="space-y-2.5 px-4 py-4">
        {rows.map(([t, at], i) => (
          <li key={t} className="flex items-center gap-3 text-sm">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
              {i === rows.length - 1 ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className="min-w-0 flex-1 text-ink-2">{t}</span>
            <span className="tabular shrink-0 text-xs text-muted">{at}</span>
          </li>
        ))}
      </ol>
    </PreviewFrame>
  );
}

/** Studio's "Create an agreement with AI" card, after Claude has suggested the details. */
export function StudioPreview() {
  const fields: [string, string, boolean][] = [
    ["Client", "Acme Widgets Inc", true],
    ["Fee", "$12,000", true],
    ["Payment due (days after invoice)", "30", true],
    ["Governing law", "Delaware", false],
  ];
  return (
    <PreviewFrame describe="the Studio card “Create an agreement with AI”, with a plain-English description and form fields marked “Suggested by Claude”.">
      <PanelHeader
        title="Create an agreement with AI"
        sub="Agreement Studio"
        badge={<Badge tone="ok" icon="spark">AI on</Badge>}
      />
      <div className="space-y-3 px-4 py-4">
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">What agreement would you like to create?</div>
          <div className="rounded-lg border border-line-strong bg-white px-3 py-2 text-[13px] leading-relaxed text-ink">
            A consulting agreement between Northwind Advisory LLC and Acme Widgets Inc for $12,000, payable within 30 days, under Delaware law.
          </div>
        </div>
        <FakeButton icon="spark">Fill details with Claude AI</FakeButton>
        <div className="grid gap-2.5 border-t border-line pt-3">
          {fields.map(([label, value, suggested]) => (
            <div key={label} className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-2">
                {label}
                {suggested && <Badge tone="warn" icon="spark">Suggested by Claude: check it</Badge>}
              </div>
              <div className="truncate rounded-md border border-line bg-subtle px-2.5 py-1.5 text-[13px] text-ink">{value}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted">Claude suggests the details for a reviewed template. You review and approve everything before it&apos;s published.</p>
      </div>
    </PreviewFrame>
  );
}

/** An answer on an agreement's Ask page: checked, with the passage it relies on. */
export function AnswerPreview() {
  return (
    <PreviewFrame describe="a question about an agreement, a verified answer, and the quoted passage it relies on with its page number.">
      <PanelHeader title="Ask about this agreement" sub="Consulting Agreement: Acme Widgets Inc" />
      <div className="space-y-3 px-4 py-4">
        <div className="ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3 py-2 text-[13px] text-white">When are invoices due?</div>
        <div className="rounded-xl border border-line bg-white p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="ok" icon="checkCircle">Verified</Badge>
            <span className="text-xs text-muted">Claude · checked against the agreement</span>
          </div>
          <p className="mt-2 text-sm text-ink">Invoices are due within 30 days of the invoice date.</p>
          <div className="mt-3 text-[11px] font-semibold tracking-wide text-muted uppercase">Relevant passages</div>
          <blockquote className="mt-1.5 border-l-2 border-brand/50 bg-subtle py-1.5 pr-2 pl-3 text-[13px] text-ink-2">
            &ldquo;Client shall pay each invoice within thirty (30) days of the invoice date.&rdquo;
            <div className="mt-1 text-xs text-muted">Section 4.2 · page 2</div>
          </blockquote>
        </div>
      </div>
    </PreviewFrame>
  );
}

/** The client's signing room on a phone. */
export function SigningPreview() {
  return (
    <PreviewFrame className="max-w-xs" describe="the client's signing screen on a phone: the agreement's signature block, an electronic-signature consent checkbox and a “Review and sign” button.">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-xs text-muted">Northwind Advisory LLC</div>
          <div className="truncate text-sm font-semibold text-ink">Consulting Agreement</div>
        </div>
        <span className="text-xs text-muted">Page 3 of 3</span>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-dashed border-line bg-subtle p-3">
          {[["NORTHWIND ADVISORY LLC", "Avery Tester"], ["CLIENT", "Jordan Sample"]].map(([h, n]) => (
            <div key={h} className="min-w-0">
              <div className="truncate text-[10px] font-semibold tracking-wide text-muted">{h}</div>
              <div className="mt-1 truncate border-b border-gray-400 pb-0.5 font-[cursive] text-lg text-brand italic">{n}</div>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-2 text-[13px] text-ink-2">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-brand text-white">
            <Icon name="check" size={11} />
          </span>
          I agree to use electronic records and signatures for this agreement.
        </div>
        <div className="flex">
          <span className="inline-flex h-10 flex-1 items-center justify-center rounded-[10px] bg-brand text-sm font-medium text-white">Review and sign</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Icon name="shield" size={14} />
          No account or download needed
        </div>
      </div>
    </PreviewFrame>
  );
}

/** The files dashboard: which agreement each file uses, and where it stands. */
export function FilesPreview() {
  const rows: { client: string; agreement: string; badge: ReactNode }[] = [
    { client: "Acme Widgets Inc", agreement: "Consulting Agreement · v3", badge: <Badge tone="ok" icon="checkCircle">Completed</Badge> },
    { client: "Contoso Ltd", agreement: "Engagement Letter · v2", badge: <Badge tone="warn" icon="clock">Reminder sent</Badge> },
    { client: "Fabrikam Inc", agreement: "Mutual NDA · v1", badge: <Badge tone="brand" icon="send">Sent to client</Badge> },
  ];
  return (
    <PreviewFrame describe="the files dashboard: three files with their agreement and version, and statuses Completed, Reminder sent and Sent to client.">
      <PanelHeader title="Files" sub="3 files · 2 waiting on a client" badge={<FakeButton icon="plus" variant="secondary">New file</FakeButton>} />
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.client} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{r.client}</div>
              <div className="truncate text-xs text-muted">{r.agreement}</div>
            </div>
            {r.badge}
          </li>
        ))}
      </ul>
    </PreviewFrame>
  );
}

export const FEATURE_PREVIEWS: Record<string, () => ReactNode> = {
  create: StudioPreview,
  understand: AnswerPreview,
  sign: SigningPreview,
  manage: FilesPreview,
};
