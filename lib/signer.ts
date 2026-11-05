import { AppError, expireIfDue, loadByToken } from "./files";

export function signerOr404(tok: string) {
  const l = loadByToken(tok);
  if (!l) throw new AppError("This signing link isn't valid. Check you used the whole link from your email.", 404);
  const file = expireIfDue(l.file, l.ws);
  return { ...l, file };
}
