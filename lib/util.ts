import crypto from "node:crypto";

export function id(prefix = ""): string {
  return prefix + crypto.randomBytes(10).toString("base64url");
}

export function token(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(data: string | Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86400_000).toISOString();
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field"
  );
}
