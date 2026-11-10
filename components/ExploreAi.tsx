// Overview: what the AI can do in this workspace, and where to try it. Fixed text only; describes the actual
// capabilities (template-based drafting, cited answers), never unrestricted legal drafting.
import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import type { AiState } from "@/lib/ai/budget";

export const EXPLORE_AI = {
  title: "Explore AI features",
  description: "Three things AgreementOS AI (Claude) can do for you. Every answer and suggestion is checked, and a person approves before anything is sent.",
  studio: { title: "Agreement Studio", text: "Create an agreement from plain English. AI fills in the details of a reviewed template; you check them and generate the draft.", example: "I need a consulting agreement between Acme Inc. and Northwind LLC for $12,000…" },
  ask: { title: "Ask about an agreement", text: "Ask a question about one agreement and get a plain-English answer that quotes the passages it relies on.", example: "What are the payment terms?" },
  knowledge: { title: "Knowledge Hub", text: "Ask a question across all your agreements. Answers cite each agreement and page, and say so when nothing supports an answer.", example: "When are invoices due?" },
  state: {
    off: "AI isn't configured on this server: these features work without it, with quoted passages and templates.",
    unverified: "Confirm your email address to turn the AI on for this workspace.",
    spend_cap: "The AI assistant has reached today's spending limit; it's back tomorrow.",
  },
} as const;

/** `askHref`: an agreement's ask page when the workspace has one, else the agreements list (where each agreement has "Ask a question"). */
export function ExploreAi({ ai, askHref }: { ai: AiState; askHref: string | null }) {
  const items = [
    { href: "/app/studio", ...EXPLORE_AI.studio },
    { href: askHref ? `${askHref}?q=${encodeURIComponent(EXPLORE_AI.ask.example)}` : "/app/agreements", ...EXPLORE_AI.ask, ...(askHref ? {} : { hint: "Upload an agreement first, then open it and choose “Ask a question”." }) },
    { href: `/app/knowledge?q=${encodeURIComponent(EXPLORE_AI.knowledge.example)}`, ...EXPLORE_AI.knowledge },
  ];
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Icon name="spark" size={18} className="text-brand" />{EXPLORE_AI.title}</span>}
        description={EXPLORE_AI.description}
        action={ai.available ? <Badge tone="ok" icon="spark">AI on</Badge> : <Badge tone={ai.reason === "off" ? "neutral" : "warn"}>AI {ai.reason === "off" ? "off" : "paused"}</Badge>}
      />
      {!ai.available && <p className="px-5 pt-3 text-sm text-warn">{EXPLORE_AI.state[ai.reason]}</p>}
      <ul aria-label="AI features" className="grid gap-3 p-5 sm:grid-cols-3">
        {items.map((it) => (
          <li key={it.title} className="relative rounded-lg border border-line bg-white p-4 transition-colors hover:border-brand/40 hover:bg-subtle">
            <Link href={it.href} className="font-semibold text-ink after:absolute after:inset-0 hover:text-brand">{it.title}</Link>
            <p className="mt-1 text-sm text-ink-2">{it.text}</p>
            <p className="mt-2 text-xs text-muted">Try: <span className="text-ink-2">&ldquo;{it.example}&rdquo;</span></p>
            {"hint" in it && it.hint && <p className="mt-1 text-xs text-muted">{it.hint}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
