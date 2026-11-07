// Document understanding (M2.1): what an analyzer may say about an agreement, and how it's validated.
// Every analyzer (the built-in rules, or a model later) returns this shape; nothing else is accepted.
import { z } from "zod";

export const CATEGORIES = ["parties", "type", "dates", "payment", "obligations", "signatures", "gaps"] as const;
export type Category = (typeof CATEGORIES)[number];

// stated:    the document says it, and a quote from the document backs it (checked, see evidence.ts)
// inferred:  read between the lines; not stated in so many words, or the quote couldn't be found
// missing:   something an agreement like this usually has, not found
// ambiguous: the document is unclear or contradicts itself
export const STATUSES = ["stated", "inferred", "missing", "ambiguous"] as const;
export type Status = (typeof STATUSES)[number];

export const EvidenceSchema = z.object({
  page: z.number().int().min(1).max(1000),
  quote: z.string().trim().min(3).max(300),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,48}$/),
  category: z.enum(CATEGORIES),
  label: z.string().trim().min(1).max(80),
  value: z.string().trim().max(300).nullable(),
  status: z.enum(STATUSES),
  evidence: z.array(EvidenceSchema).max(5),
  note: z.string().trim().max(300).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** What an analyzer hands back before the evidence check. */
export const AnalyzerOutputSchema = z.object({ findings: z.array(FindingSchema).max(80) });
export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

export type AnalyzerInfo = { kind: "rules" | "model"; name: string; model?: string };

/** What's stored: the checked findings plus how they were produced. Never edited after it's written. */
export type StoredAnalysis = {
  schema: 1;
  analyzer: AnalyzerInfo;
  findings: Finding[];
  warnings: string[];
  truncated: boolean;
  pages: number;
  ms: number;
};

export const CATEGORY_LABEL: Record<Category, string> = {
  parties: "Parties",
  type: "Agreement type and purpose",
  dates: "Dates and term",
  payment: "Payment terms",
  obligations: "Obligations and key clauses",
  signatures: "Signature requirements",
  gaps: "Missing or unclear",
};

export const STATUS_LABEL: Record<Status, string> = {
  stated: "Stated in the document",
  inferred: "Inferred, not stated",
  missing: "Not found",
  ambiguous: "Unclear",
};
