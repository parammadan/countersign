// What Studio shows about AI for this workspace, from the server's state (lib/drafts/service studioAiState). Plain
// module (no "use client"), so both the server page and the client form can use it. Fixed text only.
import type { StudioAi } from "@/lib/drafts/service";

/** Why an AI control isn't offered (fixed text; the reason comes from the server's state for this workspace). */
export const AI_UNAVAILABLE = {
  off: "AI isn't configured on this server, so the form below works on its own.",
  unverified: "Confirm your email address to use the AI assistant.",
  spend_cap: "The AI assistant has reached today's spending limit.",
} as const;
/**
 * The AI panel's wording. Claude extracts the details for one of the reviewed templates; it doesn't write a custom
 * agreement, so nothing here may say it does.
 */
export const AI_COPY = {
  heading: "Create an agreement with AI",
  intro: "Describe your agreement in everyday language. AgreementOS AI (Claude) will extract the details and fill in the agreement form for your review.",
  inputLabel: "Tell AI what you need",
  placeholder: "Example: \"I need a consulting agreement between Acme Inc. and Northwind LLC for $12,000, starting January 15, 2027, with 30 days' notice, under Delaware law.\"",
  button: "Fill details with AI",
  hint: "Review the extracted details before generating your agreement.",
  exampleButton: "Try an example",
  /** Put into the box by "Try an example", then sent to the real suggest step (no canned result). */
  example: "I need a consulting agreement between Northwind Advisory LLC (the consultant) and Acme Widgets Inc (the client). It's a one-time fixed fee of $12,000 for the project, starting 2027-01-15. Either party can end it with 30 days' notice, and Delaware law applies. The client owns the new project work; the consultant keeps its pre-existing IP.",
  working: "Claude is reading your description…",
  footnote: "AI suggests the details for one of our reviewed templates; it doesn't write a custom agreement. You review and approve everything before an agreement is published.",
} as const;

/** The Studio header's badge: on only when both AI steps are available. */
export function aiBadge(ai: StudioAi): { tone: "ok" | "neutral" | "warn"; text: string } {
  const st = !ai.suggest.available ? ai.suggest : ai.draft;
  if (st.available) return { tone: "ok", text: "AI on" };
  if (st.reason === "unverified") return { tone: "warn", text: "AI paused: confirm your email" };
  if (st.reason === "spend_cap") return { tone: "warn", text: "AI paused: daily limit reached" };
  return { tone: "neutral", text: "AI off: templates only" };
}
