import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths";

function abs(rel: string) {
  const root = path.join(dataDir(), "blobs");
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) throw new Error("bad path");
  return p;
}

export async function putBlob(rel: string, data: Uint8Array | Buffer): Promise<string> {
  const p = abs(rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  return rel;
}

export async function getBlob(rel: string): Promise<Buffer> {
  return fs.readFile(abs(rel));
}
