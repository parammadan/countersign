// Overview, brand-new workspace: four short ways in, each linking to the real screen where it happens. Fixed text
// only; it describes what each screen does now (rules reading without AI, template-based suggestions with it).
import Link from "next/link";
import { KNOWLEDGE_EXAMPLES } from "@/lib/m3/examples";
import { Badge, Card, CardHeader } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import type { AiState } from "@/lib/ai/budget";

export const KNOWLEDGE_EXAMPLE = KNOWLEDGE_EXAMPLES[0];

export type StartItem = { id: string; icon: IconName; title: string; where: string; text: string; href: string; ai?: boolean; admin?: boolean };

export const START_HERE: { title: string; description: string; items: StartItem[]; ai: Record<AiState["reason"] & string, string> } = {
  title: "Start here",
  description: "New to AgreementOS? Each of these opens the real screen and takes a minute.",
  items: [
    {
      id: "sample",
      icon: "agreement",
      title: "Try a sample agreement",
      where: "Document Intelligence",
      text: "Press “Try a sample agreement” to read a synthetic consulting agreement: its parties, fee and dates, each quoted with its page. With AI on, Claude also explains it in plain English and you can chat with it.",
      href: "/app/documents",
    },
    {
      id: "studio",
      icon: "spark",
      title: "Fill details with AI",
      where: "Agreement Studio",
      text: "Press “Try an example”, then “Fill details with AI”: Claude suggests the details of a reviewed template, and you check each one before generating the draft.",
      href: "/app/studio#ai-create",
      ai: true,
    },
    {
      id: "upload",
      icon: "upload",
      title: "Upload an agreement",
      where: "Agreements",
      text: "Upload the PDF or Word agreement you already send, check where everyone signs, and publish it. No AI needed.",
      href: "/app/agreements",
      admin: true,
    },
    {
      id: "knowledge",
      icon: "overview",
      title: "Ask the Knowledge Hub",
      where: "Knowledge Hub",
      text: `Once an agreement is uploaded, ask across all of them, for example “${KNOWLEDGE_EXAMPLE}” Answers cite the agreement and page.`,
      href: `/app/knowledge?q=${encodeURIComponent(KNOWLEDGE_EXAMPLE)}`,
      ai: true,
    },
  ],
  ai: {
    off: "AI isn't configured on this server",
    unverified: "AI starts once you confirm your email",
    spend_cap: "AI is paused until tomorrow",
  },
};

export function StartHere({ ai, admin }: { ai: AiState; admin: boolean }) {
  const items = START_HERE.items.filter((it) => admin || !it.admin);
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Icon name="arrowRight" size={18} className="text-brand" />{START_HERE.title}</span>} description={START_HERE.description} />
      <ol aria-label={START_HERE.title} className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((it, i) => (
          <li key={it.id} className="relative flex flex-col rounded-lg border border-line bg-white p-4 transition-colors hover:border-brand/40 hover:bg-subtle">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name={it.icon} size={16} /></span>
              <span className="text-xs font-medium text-muted">{i + 1} · {it.where}</span>
            </div>
            <Link href={it.href} className="mt-3 font-semibold text-ink after:absolute after:inset-0 hover:text-brand">{it.title}</Link>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-ink-2">{it.text}</p>
            {it.ai && (
              <div className="mt-3">
                {ai.available ? <Badge tone="ok" icon="spark">AI on</Badge> : <p className={ai.reason === "off" ? "text-xs text-muted" : "text-xs font-medium text-warn"}>{START_HERE.ai[ai.reason]}</p>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
