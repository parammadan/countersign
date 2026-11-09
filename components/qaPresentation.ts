// How a stored Q&A result is labelled on the ask page: which badges, which "how it was answered" line, and which
// note is raised to a notice. Display only. It reads the result the answer pipeline produced and changes nothing in
// it; whether an answer is shown, withheld or trimmed is decided in lib/qa, never here.
import { QA_STATUS_LABEL, type QaResult } from "@/lib/qa/answer";
import type { IconName } from "./icons";

export type QaKind =
  | "ai_off" // no model on this server: the most relevant passages
  | "budget" // a model is configured but today's spending limit was reached: passages instead
  | "ai_failed" // the model call failed (timeout, refusal, bad output): passages instead
  | "withheld" // the model wrote an answer that didn't pass the checks: it isn't shown
  | "not_found" // the model found nothing in the agreement to answer with
  | "removed" // shown, but a statement that couldn't be confirmed was removed
  | "qualified" // shown, with points that couldn't be confirmed
  | "checked"; // shown, every check passed
export type QaBadge = { label: string; tone: "ok" | "warn" | "neutral"; icon?: IconName };
export type QaPresentation = { kind: QaKind; badges: QaBadge[]; how: string; notice?: string; notes: string[]; answer?: string };

/** Without a model nothing is "answered": the result is the passages that match best, shown neutrally. */
export const PASSAGES_LABEL = "Relevant passages";
// the notes lib/qa/store.ts adds when it falls back to passages (tested against its source)
export const BUDGET_NOTE = /spending limit/i;
export const FAILED_NOTE = /couldn['’]t answer just now/i;
// every reason an answer is withheld ends this way (lib/qa/answer.ts, withheld())
const WITHHELD_NOTE = /isn['’]t shown\.?$/;
const REMOVED = /was removed from this answer/;

type R = Pick<QaResult, "status" | "mode" | "model" | "warnings" | "citations" | "verification" | "unverified" | "verifiedBy">;

export function qaKind(r: R): QaKind {
  if (r.mode === "passages") return r.warnings.some((w) => BUDGET_NOTE.test(w)) ? "budget" : r.warnings.some((w) => FAILED_NOTE.test(w)) ? "ai_failed" : "ai_off";
  // a model answer that passed the checks always carries a verification; withheld() sets none
  if (!r.verification) return r.status === "partial" || r.warnings.some((w) => WITHHELD_NOTE.test(w)) ? "withheld" : "not_found";
  if (r.unverified?.some((u) => REMOVED.test(u))) return "removed";
  return r.verification === "qualified" ? "qualified" : "checked";
}

export function qaPresentation(r: R): QaPresentation {
  const kind = qaKind(r);
  const passagesBadge: QaBadge = r.status === "not_found" ? { label: QA_STATUS_LABEL.not_found, tone: "neutral" } : { label: PASSAGES_LABEL, tone: "neutral" };
  const statusBadge: QaBadge = { label: QA_STATUS_LABEL[r.status], tone: r.status === "answered" ? "ok" : r.status === "partial" ? "warn" : "neutral" };
  const claude = `Claude (${r.model})`;
  const second = r.verifiedBy ? ` by a second check (${r.verifiedBy})` : "";
  const lift = (re: RegExp) => {
    const notice = r.warnings.find((w) => re.test(w));
    return { notice, notes: r.warnings.filter((w) => w !== notice) };
  };
  switch (kind) {
    case "ai_off":
      return { kind, badges: [passagesBadge], how: "Quoted passages, no AI", notes: r.warnings };
    case "budget":
      return { kind, badges: [passagesBadge, { label: "AI paused: spending limit", tone: "warn", icon: "clock" }], how: "Quoted passages, no AI", ...lift(BUDGET_NOTE) };
    case "ai_failed":
      return { kind, badges: [passagesBadge, { label: "AI unavailable", tone: "warn", icon: "alert" }], how: "Quoted passages, no AI", ...lift(FAILED_NOTE) };
    case "withheld":
      return {
        kind,
        badges: [{ label: "Answer withheld", tone: "warn", icon: "alert" }],
        how: `${claude} · its answer didn't pass AgreementOS's checks${r.citations.length ? "; the passages it relied on are shown instead" : ""}`,
        notes: r.warnings,
        // with nothing to cite, the stored text is the generic "not found"; say what actually happened
        ...(r.citations.length ? {} : { answer: "No answer is shown: the AI's answer couldn't be checked against the agreement's text. Ask in other words, or read the agreement." }),
      };
    case "not_found":
      return { kind, badges: [statusBadge], how: `${claude} · nothing in the agreement answers this`, notes: r.warnings };
    case "removed":
      return { kind, badges: [statusBadge, { label: "Part removed", tone: "warn", icon: "alert" }], how: `${claude} · partly verified${second || " against the agreement"}; a statement it couldn't confirm was removed`, notes: r.warnings };
    case "qualified":
      return { kind, badges: [statusBadge, { label: "Partly verified", tone: "warn", icon: "alert" }], how: `${claude} · partly verified${second || " against the agreement"}`, notes: r.warnings };
    case "checked":
      return { kind, badges: [statusBadge, { label: "Verified", tone: "ok", icon: "checkCircle" }], how: `${claude} · ${r.verifiedBy ? `verified claim by claim${second}` : "checked against the agreement"}`, notes: r.warnings };
  }
}
