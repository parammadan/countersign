import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths";
import { AppError } from "./errors";

function abs(rel: string) {
  const root = path.resolve(dataDir(), "blobs");
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error("bad path");
  return p;
}

// Keep a reserve free so the database (and every other tenant) can always still write.
const RESERVE = 150 * 1024 * 1024;
export async function ensureDiskSpace(needed: number) {
  try {
    const st = await fs.statfs(dataDir());
    if (st.bavail * st.bsize - needed < RESERVE) {
      console.error("[storage] low disk space");
      throw new AppError("Storage is temporarily full. Please try again later.", 507);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
  }
}

export async function putBlob(rel: string, data: Uint8Array | Buffer): Promise<string> {
  await ensureDiskSpace(data.length);
  const p = abs(rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  return rel;
}

export async function getBlob(rel: string): Promise<Buffer> {
  return fs.readFile(abs(rel));
}
