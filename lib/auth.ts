import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { one, run } from "./db";
import { addDays, now, sha256, token } from "./util";

const COOKIE = "cs_session";
const SESSION_DAYS = 14;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt" || !s || !k) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, "base64"), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, "base64");
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

export async function createSession(userId: string, workspaceId: string) {
  const t = token(32);
  const exp = addDays(now(), SESSION_DAYS);
  run("INSERT INTO sessions (id_hash, user_id, workspace_id, expires_at, created_at) VALUES (?,?,?,?,?)", sha256(t), userId, workspaceId, exp, now());
  const jar = await cookies();
  jar.set(COOKIE, t, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !process.env.APP_URL?.startsWith("http://"),
    path: "/",
    expires: new Date(exp),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const t = jar.get(COOKIE)?.value;
  if (t) run("DELETE FROM sessions WHERE id_hash = ?", sha256(t));
  jar.delete(COOKIE);
}

export type Session = {
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  role: "owner" | "admin" | "staff";
};

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const t = jar.get(COOKIE)?.value;
  if (!t) return null;
  const row = one<{ user_id: string; workspace_id: string; expires_at: string; name: string; email: string; role: Session["role"] }>(
    `SELECT s.user_id, s.workspace_id, s.expires_at, u.name, u.email, m.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     JOIN members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
     WHERE s.id_hash = ?`,
    sha256(t),
  );
  if (!row || row.expires_at < now()) return null;
  return { userId: row.user_id, userName: row.name, userEmail: row.email, workspaceId: row.workspace_id, role: row.role };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireSession();
  if (s.role === "staff") redirect("/app?error=admin");
  return s;
}
