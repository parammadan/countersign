import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

let cached: Buffer | null = null;

// APP_SECRET in production; a generated one persisted next to the DB in dev.
function key(): Buffer {
  if (cached) return cached;
  let s = process.env.APP_SECRET;
  // production fails closed: a generated secret would differ on a new volume or machine and silently break every
  // signing link already sent
  if (!s && process.env.NODE_ENV === "production") throw new Error("APP_SECRET is not set. It is required in production (e.g. openssl rand -hex 32) and must never change.");
  if (!s) {
    const p = path.join(dataDir(), ".secret");
    fs.mkdirSync(dataDir(), { recursive: true });
    if (fs.existsSync(p)) s = fs.readFileSync(p, "utf8").trim();
    else {
      s = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(p, s, { mode: 0o600 });
    }
  }
  cached = crypto.createHash("sha256").update(s).digest();
  return cached;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !enc || tag.length !== 16) throw new Error("bad sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
