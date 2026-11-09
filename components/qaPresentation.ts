// How a stored Q&A result is labelled on the ask page. Display only: the result itself (its status, citations and
// the checks that produced it) is never changed here.
import { QA_STATUS_LABEL, type QaResult } from "@/lib/qa/answer";

export type QaBadge = { label: string; tone: "ok" | "warn" | "neutral" };
export type QaPresentation = { badge: QaBadge; how: string };

/** Without a model nothing is "answered": the result is the passages that match best, shown neutrally. */
export const PASSAGES_LABEL = "Relevant passages";

export function qaPresentation(r: Pick<QaResult, "status" | "mode" | "model">): QaPresentation {
  if (r.mode === "passages") {
    return {
      badge: r.status === "not_found" ? { label: QA_STATUS_LABEL.not_found, tone: "neutral" } : { label: PASSAGES_LABEL, tone: "neutral" },
      how: "Passages, no AI model",
    };
  }
  const tone = r.status === "answered" ? "ok" : r.status === "partial" ? "warn" : "neutral";
  return { badge: { label: QA_STATUS_LABEL[r.status], tone }, how: `AI assistant (${r.model})` };
}
