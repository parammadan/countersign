// What Studio shows about AI for this workspace, from the server's state (lib/drafts/service studioAiState). Plain
// module (no "use client"), so both the server page and the client form can use it. Fixed text only.
import type { StudioAi } from "@/lib/drafts/service";

/** Why an AI control isn't offered (fixed text; the reason comes from the server's state for this workspace). */
export const AI_UNAVAILABLE = {
  off: "AI isn't configured on this server, so the form below works on its own.",
  unverified: "Confirm your email address to use the AI assistant.",
  spend_cap: "The AI assistant has reached today's spending limit.",
} as const;
/** The Studio header's badge: on only when both AI steps are available. */
export function aiBadge(ai: StudioAi): { tone: "ok" | "neutral" | "warn"; text: string } {
  const st = !ai.suggest.available ? ai.suggest : ai.draft;
  if (st.available) return { tone: "ok", text: "AI on" };
  if (st.reason === "unverified") return { tone: "warn", text: "AI paused: confirm your email" };
  if (st.reason === "spend_cap") return { tone: "warn", text: "AI paused: daily limit reached" };
  return { tone: "neutral", text: "AI off: templates only" };
}
