import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";
import { AppError } from "./errors";

export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return privateIp(l.slice(7));
  return l === "::1" || l === "::" || /^(fc|fd|fe[89ab]|fec|fed|fee|fef|ff)/.test(l) || l.startsWith("64:ff9b:") || l.startsWith("2001:db8");
}

const BLOCKED = "Webhook URLs must point at a public internet address.";
const allowPrivate = () => process.env.ALLOW_PRIVATE_WEBHOOKS === "1";

// Static checks when a firm saves a webhook URL. The real guard is at connect time (below).
export async function checkWebhookUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("Enter a full URL, like https://hooks.example.com/countersign");
  }
  if (u.protocol !== "https:" && !(allowPrivate() && u.protocol === "http:")) throw new AppError("Webhook URLs must use https://");
  if (u.username || u.password) throw new AppError("Don't put credentials in the URL.");
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && privateIp(host)) throw new AppError(BLOCKED);
  const addrs = await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new AppError(BLOCKED);
  return u;
}

// DNS lookup that refuses private addresses, used for the actual connection, so a hostname
// can't pass the check and then rebind to an internal IP.
const safeLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 0);
    const list = addrs as dns.LookupAddress[];
    if (!allowPrivate() && list.some((a) => privateIp(a.address))) return cb(Object.assign(new Error(BLOCKED), { code: "EBLOCKED" }), "", 0);
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 10_000 }, headersTimeout: 10_000, bodyTimeout: 10_000 });

export function safeFetch(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
  return ufetch(url, { ...init, redirect: "manual", dispatcher: agent, signal: AbortSignal.timeout(12_000) });
}
