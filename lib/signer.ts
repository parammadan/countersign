import { cookies } from "next/headers";
import { AppError, copyLinkClosed, expireIfDue, loadByToken } from "./files";
import { seal, unseal } from "./secret";
import type { FileRow, Workspace } from "./types";

export function signerOr404(tok: string) {
  const l = loadByToken(tok);
  if (!l) throw new AppError("This signing link isn't valid. Check you used the whole link from your email.", 404);
  const file = expireIfDue(l.file, l.ws);
  if (copyLinkClosed(file)) throw new AppError(`This link has expired. Ask ${l.ws.name} for a copy of the signed agreement.`, 410);
  return { ...l, file };
}

// The emailed code proves the person holding *this browser* controls the inbox, so the proof
// lives in an httpOnly cookie for this file, not on the file row (a forwarded link alone isn't enough).
const name = (fileId: string) => `cs_v_${fileId.replace(/[^A-Za-z0-9_-]/g, "")}`;
const TTL = 12 * 3600_000;

/** The sealed cookie value. Made before the code is used up, so a sealing failure (no APP_SECRET) leaves it usable. */
export function signerProof(fileId: string): string {
  return seal(`${fileId}|${Date.now() + TTL}`);
}

export async function markSignerVerified(fileId: string, proof = signerProof(fileId)) {
  const jar = await cookies();
  jar.set(name(fileId), proof, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !process.env.APP_URL?.startsWith("http://"),
    path: "/",
    maxAge: TTL / 1000,
  });
}

export async function signerVerified(file: FileRow, ws: Workspace): Promise<boolean> {
  if (!ws.require_otp) return true;
  const v = (await cookies()).get(name(file.id))?.value;
  if (!v) return false;
  try {
    const [fid, exp] = unseal(v).split("|");
    return fid === file.id && Number(exp) > Date.now();
  } catch {
    return false;
  }
}

export async function requireSigner(file: FileRow, ws: Workspace) {
  if (!(await signerVerified(file, ws))) throw new AppError("Verify the code we emailed you first.", 403);
}
