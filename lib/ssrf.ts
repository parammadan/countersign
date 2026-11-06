import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";
import { AppError } from "./errors";

// separate lists: a mixed list matches IPv4 addresses against IPv6 rules like ::/96
const BL4 = new net.BlockList();
const BL6 = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) BL4.addSubnet(a, p, "ipv4");
// ::/96 covers ::1 and IPv4-compatible forms; ::ffff:0:0/96 covers every IPv4-mapped address
for (const [a, p] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) BL6.addSubnet(a, p, "ipv6");

export function privateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return BL4.check(ip, "ipv4");
  if (v === 6) return BL6.check(ip, "ipv6");
  return true; // not an IP: treat as unsafe
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
  // IP literals skip DNS (and so the connect-time guard): require a hostname
  if (net.isIP(host)) throw new AppError("Use a hostname, not an IP address, for webhook URLs.");
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
