// Document Intelligence's input limits and their messages, in one plain module: the server enforces them
// (lib/intake/service) and the upload form checks a chosen file against the same numbers before sending it, so a file
// over the server's request limit gets the real reason instead of a failed request.

/** Server actions accept request bodies up to 2 MB (next.config.ts, owner-reserved), so uploads here stop below that. */
export const MAX_INTAKE_UPLOAD = 1_900_000;
export const MAX_PASTE_CHARS = 200_000;
export const ACCEPTED_EXT = [".pdf", ".docx", ".doc", ".odt", ".rtf"] as const;

export const LIMIT_MESSAGE = {
  tooLarge: "Files up to 1.9 MB can be read here. Paste the text instead, or save a smaller PDF.",
  wrongType: "Upload a PDF or Word document (.pdf, .docx, .doc, .odt, .rtf).",
  empty: "That file is empty.",
} as const;

/** Why a chosen file can't be read here (the server's own checks, run before uploading), or null. */
export function fileProblem(f: { name: string; size: number }): string | null {
  if (f.size === 0) return LIMIT_MESSAGE.empty;
  if (f.size > MAX_INTAKE_UPLOAD) return LIMIT_MESSAGE.tooLarge;
  const ext = (f.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase();
  // the server also accepts any file that starts like a PDF; a file without a known extension is left to it
  if (ext && !(ACCEPTED_EXT as readonly string[]).includes(ext)) return LIMIT_MESSAGE.wrongType;
  return null;
}
