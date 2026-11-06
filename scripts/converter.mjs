// Word -> PDF converter, run as its own unprivileged user (see Dockerfile). It never sees the app's data:
// the app POSTs one document to it over localhost and gets the PDF back. Untrusted documents are parsed
// by LibreOffice here, under a user that can't read /data, the database or the app's secret.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.CONVERTER_PORT || 8091);
const MAX = 20 * 1024 * 1024;
const EXT = new Set([".docx", ".doc", ".odt", ".rtf"]);
const SOFFICE = process.env.SOFFICE_PATH || "soffice";

async function convert(data, ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-"));
  const input = path.join(dir, "input" + ext);
  await fs.writeFile(input, data);
  const profile = "file://" + path.join(dir, "profile-" + crypto.randomBytes(4).toString("hex"));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(SOFFICE, [`-env:UserInstallation=${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, input], {
        detached: true,
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "en_US.UTF-8", SAL_USE_VCLPLUGIN: "svp" },
      });
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        killGroup();
        reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
      }, 60_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        killGroup();
        code === 0 ? resolve() : reject(new Error(`soffice exited ${code}`));
      });
    });
    return await fs.readFile(path.join(dir, "input.pdf"));
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    if (req.method !== "POST" || req.url !== "/convert") return res.writeHead(404).end();
    const ext = String(req.headers["x-ext"] || "").toLowerCase();
    if (!EXT.has(ext)) return res.writeHead(400).end("bad extension");
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX) return res.writeHead(413).end();
      chunks.push(c);
    }
    try {
      const pdf = await convert(Buffer.concat(chunks), ext);
      res.writeHead(200, { "Content-Type": "application/pdf" }).end(pdf);
    } catch (e) {
      const status = e?.code === "TIMEOUT" ? 504 : e?.code === "ENOENT" ? 503 : 422;
      res.writeHead(status).end(String(e?.message || e).slice(0, 200));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[converter] listening on 127.0.0.1:${PORT} as uid ${process.getuid?.()}`));
