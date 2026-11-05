import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "./errors";

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return privateIp(l.slice(7));
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

// Webhook targets are firm-supplied URLs: block internal network addresses.
export async function checkWebhookUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("Enter a full URL, like https://hooks.example.com/countersign");
  }
  const allowHttp = process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new AppError("Webhook URLs must use https://");
  if (u.username || u.password) throw new AppError("Don't put credentials in the URL.");
  if (allowHttp) return u;
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError(`Can't resolve ${u.hostname}.`);
  if (addrs.some((a) => privateIp(a.address))) throw new AppError("Webhook URLs can't point at private or internal addresses.");
  return u;
}
