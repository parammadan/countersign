import path from "node:path";

export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

let warned = false;
export function appUrl(): string {
  if (!process.env.APP_URL && process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.error("[config] APP_URL is not set: links in emails will point at localhost. Set APP_URL to the public URL.");
  }
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
