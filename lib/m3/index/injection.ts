import { detectInjection } from "../security/sanitize";

/** Heuristic screen for text that tries to instruct the model. No model call. Matches mean "never binding". */

/** NFKC and strip zero-width/format characters; whitespace is collapsed separately (PDF text has stray newlines). */
function strip(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\b(?!\s+(?:any\s+|all\s+)?applicable\s+(?:rules|laws?)\s+of\s+(?:procedure|law)\b)[^.]{0,40}\b(previous|prior|above|earlier|all|any|system|everything)\b[^.]{0,30}\b(instructions?|prompts?|rules?|guidelines?|above|said)\b/i,
  /\b(ignore|disregard|forget)\s+(everything|all)\s+(above|before|previously)\b/i,
  /\bdo\s+not\s+follow\b[^.]{0,30}\b(previous|prior|above|earlier|system)\b[^.]{0,20}\b(instructions?|prompts?|rules?)\b/i,
  /\b(reveal|print|show|repeat|leak)\b[^.]{0,30}\b(system|hidden|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\s+(a|an|the|my|in|acting|playing|dan)\b(?!\s+(liable|responsible|obliged|bound|entitled))/i,
  /\bnew\s+instructions?\s*:/i,
  /\bdo\s+not\s+(tell|inform|mention)[^.]{0,20}\b(user|client|anyone)\b/i,
  /<\/?\s*(system|assistant|developer|tool|instructions?)\s*>/i,
  /\b(act|respond|answer)\s+as\s+(if|though)\b[^.]{0,30}\b(binding|approved|authorized|authorised)\b/i,
];

/** Tested on the text with newlines preserved. Known trade-off: a definitions line such as "System: means ..." is also flagged (fails closed). */
// compat: [ \t]* instead of \s* at the line start (same matches with the m flag, since every line start is tried)
// keeps a passage of many blank lines linear instead of quadratic.
const LINE_PATTERNS: RegExp[] = [/^[ \t]*(system|assistant)\s*:/im];

export function looksLikeInjection(text: string): boolean {
  const lines = strip(text); // newlines kept so line-anchored patterns can see role lines mid-passage
  const flat = lines.replace(/\s+/g, " ");
  if (PATTERNS.some((p) => p.test(flat)) || LINE_PATTERNS.some((p) => p.test(lines))) return true;
  // S6's keyword detector too (it folds homoglyphs, spaced letters and hidden characters). Keywords only: the
  // structural addressed-to-reader screen is a soft flag in security/sanitize.ts, never a reason to withhold a passage.
  return detectInjection(text);
}
